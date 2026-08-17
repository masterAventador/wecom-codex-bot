import { chmod, copyFile, mkdir, rm, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ArtifactPublisher, PublishedArtifact } from "./artifact-publisher.ts";
import { buildCodexPrompt, type CodexRunResult, type RunCodexOptions } from "./codex-runner.ts";
import type { BotConfig } from "./config.ts";
import type { GitWorkspace } from "./git-workspace.ts";
import {
  ClarificationNeededError,
  type IssueTriageDecision,
  type IssueTriageOptions,
} from "./issue-triage.ts";
import type { CommandResult, RunCommandOptions } from "./process-runner.ts";
import { detectTaskActions } from "./task-actions.ts";

type PrepareWorkspaceOptions = {
  repositoryPath: string;
  baseBranch: string;
  remote: string;
  fetchBeforeTask: boolean;
  branchName: string;
  worktreeName: string;
};

type MergeWorkspaceOptions = {
  repositoryPath: string;
  baseBranch: string;
  taskBranch: string;
  worktreePath: string;
};

type TaskWorkflowDependencies = {
  prepareWorkspace(options: PrepareWorkspaceOptions): Promise<GitWorkspace>;
  mergeWorkspace?(options: MergeWorkspaceOptions): Promise<void>;
  triageIssue?(options: IssueTriageOptions): Promise<IssueTriageDecision>;
  runCommand(options: RunCommandOptions): Promise<CommandResult>;
  runCodex(options: RunCodexOptions): Promise<CodexRunResult>;
  findArtifact(worktreePath: string, artifactGlobs: readonly string[]): Promise<string>;
  publisher: ArtifactPublisher;
};

export type TaskWorkflowInput = {
  taskId: string;
  projectId: string;
  prompt: string;
  imagePaths: readonly string[];
  filePaths: readonly string[];
  config: BotConfig;
  onProgress(message: string): void;
};

type TaskWorkflowResultBase = {
  taskId: string;
  projectId: string;
  branchName: string;
  commitHash: string;
  codexSummary: string;
  mergedToBaseBranch?: string;
  deployed?: true;
};

export type TaskWorkflowResult = TaskWorkflowResultBase & (
  | { deliveryMode: "code" }
  | { deliveryMode: "artifact"; artifact: PublishedArtifact }
) | {
  taskId: string;
  projectId: string;
  deliveryMode: "answer";
  answer: string;
  branchName?: never;
  commitHash?: never;
  codexSummary?: never;
  mergedToBaseBranch?: never;
  deployed?: never;
};

const BOT_SECRET_KEYS = new Set(["WECOM_BOT_SECRET", "COS_SECRET_ID", "COS_SECRET_KEY"]);
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 30 * 60_000;
const BUILD_TIMEOUT_MS = 45 * 60_000;
const SAFE_TASK_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function createSafeProjectEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => value !== undefined && !BOT_SECRET_KEYS.has(key)),
  );
}

function command(value: string[]): [string, ...string[]] {
  const [executable, ...args] = value;
  if (executable === undefined) {
    throw new Error("命令配置不能为空");
  }
  return [executable, ...args];
}

function commitMessage(prompt: string): string {
  const summary = prompt.replace(/\s+/g, " ").trim().slice(0, 60);
  return `fix(bot): ${summary}`;
}

type StagedQuotedFiles = {
  relativePaths: string[];
  cleanup(): Promise<void>;
};

async function stageQuotedFiles(
  worktreePath: string,
  taskId: string,
  sourcePaths: readonly string[],
): Promise<StagedQuotedFiles> {
  if (sourcePaths.length === 0) {
    return { relativePaths: [], cleanup: async () => undefined };
  }
  if (!SAFE_TASK_ID_PATTERN.test(taskId)) {
    throw new Error("任务编号含有不安全字符，无法暂存引用文件");
  }
  const inputRoot = join(worktreePath, ".wecom-input");
  const taskDirectory = join(inputRoot, taskId);
  await mkdir(inputRoot, { recursive: true });
  await mkdir(taskDirectory);
  const cleanup = async () => {
    await rm(taskDirectory, { recursive: true, force: true });
    await rmdir(inputRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") {
        throw error;
      }
    });
  };
  const relativePaths: string[] = [];
  try {
    for (const [index, sourcePath] of sourcePaths.entries()) {
      const rawName = basename(sourcePath);
      const normalizedName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
      const safeName = normalizedName === "." || normalizedName === ".." || normalizedName.length === 0
        ? `attachment-${index + 1}.bin`
        : normalizedName;
      const filename = `${index + 1}-${safeName}`;
      const destinationPath = join(taskDirectory, filename);
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o400);
      relativePaths.push(`.wecom-input/${taskId}/${filename}`);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { relativePaths, cleanup };
}

export class TaskWorkflow {
  readonly #dependencies: TaskWorkflowDependencies;

  constructor(dependencies: TaskWorkflowDependencies) {
    this.#dependencies = dependencies;
  }

  async run(input: TaskWorkflowInput): Promise<TaskWorkflowResult> {
    const { config } = input;
    const project = config.projects[input.projectId];
    if (project === undefined) {
      throw new Error(`项目未登记：${input.projectId}`);
    }
    const actions = detectTaskActions(input.prompt);
    if (actions.codeChange && this.#dependencies.triageIssue !== undefined) {
      input.onProgress("正在只读判断消息意图和需求完整性");
      const decision = await this.#dependencies.triageIssue({
        binary: config.codex.binary,
        cwd: project.path,
        issueDescription: input.prompt,
        imagePaths: input.imagePaths,
        filePaths: input.filePaths,
        timeoutMs: Math.min(config.codex.timeoutMinutes * 60_000, 120_000),
      });
      if (decision.kind === "clarify") {
        throw new ClarificationNeededError(decision.question);
      }
      if (decision.kind === "answer") {
        return {
          taskId: input.taskId,
          projectId: input.projectId,
          deliveryMode: "answer",
          answer: decision.answer,
        };
      }
    }
    if (
      actions.packageArtifact
      && (
        project.deliveryMode !== "artifact"
        || project.buildCommand === undefined
        || project.artifactGlobs === undefined
      )
    ) {
      throw new Error(`项目 ${project.displayName} 未配置安装包构建能力`);
    }
    if (actions.deploy && project.deployCommand === undefined) {
      throw new Error(`项目 ${project.displayName} 未配置部署命令，不会让 Codex 猜测部署方式`);
    }
    if (actions.deploy && !config.git.mergeToBaseBranch) {
      throw new Error("部署任务要求先启用 git.mergeToBaseBranch，确保只从基础分支部署");
    }
    const branchName = `${config.git.branchPrefix}/${input.taskId}`;
    input.onProgress("正在创建独立 Git 工作区");
    const workspace = await this.#dependencies.prepareWorkspace({
      repositoryPath: project.path,
      baseBranch: project.baseBranch,
      remote: project.remote,
      fetchBeforeTask: project.fetchBeforeTask,
      branchName,
      worktreeName: input.taskId,
    });
    const projectEnvironment = createSafeProjectEnvironment(process.env);

    if (project.installCommand !== undefined) {
      input.onProgress("正在安装项目依赖");
      await this.#dependencies.runCommand({
        command: command(project.installCommand),
        cwd: workspace.worktreePath,
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: projectEnvironment,
      });
    }

    let codexResult: CodexRunResult;
    if (actions.codeChange) {
      const quotedFiles = await stageQuotedFiles(
        workspace.worktreePath,
        input.taskId,
        input.filePaths,
      );
      try {
        input.onProgress("Codex 正在分析和修改代码");
        codexResult = await this.#dependencies.runCodex({
          binary: config.codex.binary,
          cwd: workspace.worktreePath,
          prompt: buildCodexPrompt(input.prompt, quotedFiles.relativePaths),
          timeoutMs: config.codex.timeoutMinutes * 60_000,
          imagePaths: input.imagePaths,
          onProgress: input.onProgress,
        });
      } finally {
        await quotedFiles.cleanup();
      }
    } else {
      codexResult = {
        finalMessage: "未要求修改代码，仅执行消息中明确要求的交付动作。",
        stderr: "",
      };
    }

    const status = await this.#dependencies.runCommand({
      command: ["git", "status", "--porcelain"],
      cwd: workspace.worktreePath,
      timeoutMs: 30_000,
      env: projectEnvironment,
    });
    const hasChanges = status.stdout.trim().length > 0;
    if (!hasChanges && actions.codeChange) {
      throw new Error("Codex 没有产生代码改动，任务已停止");
    }

    input.onProgress(hasChanges ? "代码已修改，正在运行测试" : "正在运行项目测试");
    await this.#dependencies.runCommand({
      command: command(project.testCommand),
      cwd: workspace.worktreePath,
      timeoutMs: TEST_TIMEOUT_MS,
      env: projectEnvironment,
    });

    let artifactPath: string | undefined;
    if (actions.packageArtifact) {
      if (project.buildCommand === undefined || project.artifactGlobs === undefined) {
        throw new Error("安装包交付项目缺少构建配置");
      }
      input.onProgress("测试通过，正在构建 Electron 安装包");
      await this.#dependencies.runCommand({
        command: command(project.buildCommand),
        cwd: workspace.worktreePath,
        timeoutMs: BUILD_TIMEOUT_MS,
        env: projectEnvironment,
      });
      artifactPath = await this.#dependencies.findArtifact(
        workspace.worktreePath,
        project.artifactGlobs,
      );
    }

    if (config.git.commitChanges && hasChanges) {
      const gitEnvironment = {
        ...projectEnvironment,
        GIT_AUTHOR_NAME: config.git.authorName,
        GIT_AUTHOR_EMAIL: config.git.authorEmail,
        GIT_COMMITTER_NAME: config.git.authorName,
        GIT_COMMITTER_EMAIL: config.git.authorEmail,
      };
      await this.#dependencies.runCommand({
        command: ["git", "add", "-A"],
        cwd: workspace.worktreePath,
        timeoutMs: 30_000,
        env: gitEnvironment,
      });
      await this.#dependencies.runCommand({
        command: ["git", "commit", "-m", commitMessage(input.prompt)],
        cwd: workspace.worktreePath,
        timeoutMs: 120_000,
        env: gitEnvironment,
      });
      if (config.git.pushBranches) {
        input.onProgress("正在推送机器人任务分支");
        await this.#dependencies.runCommand({
          command: ["git", "push", "--set-upstream", project.remote, branchName],
          cwd: workspace.worktreePath,
          timeoutMs: 180_000,
          env: gitEnvironment,
        });
      }
    }

    const commit = await this.#dependencies.runCommand({
      command: ["git", "rev-parse", "--short", "HEAD"],
      cwd: workspace.worktreePath,
      timeoutMs: 30_000,
      env: projectEnvironment,
    });

    const result: TaskWorkflowResultBase = {
      taskId: input.taskId,
      projectId: input.projectId,
      branchName,
      commitHash: commit.stdout.trim(),
      codexSummary: codexResult.finalMessage,
    };
    let artifact: PublishedArtifact | undefined;
    if (actions.packageArtifact) {
      if (artifactPath === undefined) {
        throw new Error("安装包交付项目没有生成安装包");
      }
      input.onProgress("构建完成，正在上传安装包");
      artifact = await this.#dependencies.publisher.publish(artifactPath, input.taskId);
    }

    if (config.git.mergeToBaseBranch) {
      if (this.#dependencies.mergeWorkspace === undefined) {
        throw new Error("自动合并已开启，但未配置 Git 合并器");
      }
      input.onProgress(`交付检查通过，正在合并到 ${project.baseBranch}`);
      await this.#dependencies.mergeWorkspace({
        repositoryPath: project.path,
        baseBranch: project.baseBranch,
        taskBranch: branchName,
        worktreePath: workspace.worktreePath,
      });
      result.mergedToBaseBranch = project.baseBranch;
      input.onProgress(`已合并到 ${project.baseBranch}，任务分支和 worktree 已清理`);
    }

    if (actions.deploy) {
      if (project.deployCommand === undefined) {
        throw new Error(`项目 ${project.displayName} 未配置部署命令`);
      }
      input.onProgress(`正在从 ${project.baseBranch} 执行项目预设部署命令`);
      try {
        await this.#dependencies.runCommand({
          command: command(project.deployCommand),
          cwd: project.path,
          timeoutMs: BUILD_TIMEOUT_MS,
          env: projectEnvironment,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`代码已合并到 ${project.baseBranch}，但部署失败：${message}`);
      }
      result.deployed = true;
      input.onProgress("部署命令执行完成，正在发送结果");
    } else if (!config.git.mergeToBaseBranch && !actions.packageArtifact) {
      input.onProgress("代码任务完成，正在发送结果");
    } else if (!config.git.mergeToBaseBranch) {
      input.onProgress("安装包已上传，正在发送结果");
    }

    if (!actions.packageArtifact) {
      return { ...result, deliveryMode: "code" };
    }
    if (artifact === undefined) {
      throw new Error("安装包交付项目没有发布安装包");
    }
    return { ...result, deliveryMode: "artifact", artifact };
  }
}
