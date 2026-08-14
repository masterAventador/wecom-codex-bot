import type { ArtifactPublisher, PublishedArtifact } from "./artifact-publisher.ts";
import { buildCodexPrompt, type CodexRunResult, type RunCodexOptions } from "./codex-runner.ts";
import type { BotConfig } from "./config.ts";
import type { GitWorkspace } from "./git-workspace.ts";
import type { CommandResult, RunCommandOptions } from "./process-runner.ts";

type PrepareWorkspaceOptions = {
  repositoryPath: string;
  baseBranch: string;
  remote: string;
  fetchBeforeTask: boolean;
  branchName: string;
  worktreeName: string;
};

type TaskWorkflowDependencies = {
  prepareWorkspace(options: PrepareWorkspaceOptions): Promise<GitWorkspace>;
  runCommand(options: RunCommandOptions): Promise<CommandResult>;
  runCodex(options: RunCodexOptions): Promise<CodexRunResult>;
  findArtifact(worktreePath: string, artifactGlobs: readonly string[]): Promise<string>;
  publisher: ArtifactPublisher;
};

export type TaskWorkflowInput = {
  taskId: string;
  prompt: string;
  imagePaths: readonly string[];
  config: BotConfig;
  onProgress(message: string): void;
};

export type TaskWorkflowResult = {
  taskId: string;
  branchName: string;
  commitHash: string;
  codexSummary: string;
  artifact: PublishedArtifact;
};

const BOT_SECRET_KEYS = new Set(["WECOM_BOT_SECRET", "COS_SECRET_ID", "COS_SECRET_KEY"]);
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 30 * 60_000;
const BUILD_TIMEOUT_MS = 45 * 60_000;

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

export class TaskWorkflow {
  readonly #dependencies: TaskWorkflowDependencies;

  constructor(dependencies: TaskWorkflowDependencies) {
    this.#dependencies = dependencies;
  }

  async run(input: TaskWorkflowInput): Promise<TaskWorkflowResult> {
    const { config } = input;
    const branchName = `${config.git.branchPrefix}/${input.taskId}`;
    input.onProgress("正在创建独立 Git 工作区");
    const workspace = await this.#dependencies.prepareWorkspace({
      repositoryPath: config.repository.path,
      baseBranch: config.repository.baseBranch,
      remote: config.repository.remote,
      fetchBeforeTask: config.repository.fetchBeforeTask,
      branchName,
      worktreeName: input.taskId,
    });
    const projectEnvironment = createSafeProjectEnvironment(process.env);

    input.onProgress("正在安装项目依赖");
    await this.#dependencies.runCommand({
      command: command(config.repository.installCommand),
      cwd: workspace.worktreePath,
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: projectEnvironment,
    });

    input.onProgress("Codex 正在分析和修改代码");
    const codexResult = await this.#dependencies.runCodex({
      binary: config.codex.binary,
      cwd: workspace.worktreePath,
      prompt: buildCodexPrompt(input.prompt),
      timeoutMs: config.codex.timeoutMinutes * 60_000,
      imagePaths: input.imagePaths,
      onProgress: input.onProgress,
    });

    const status = await this.#dependencies.runCommand({
      command: ["git", "status", "--porcelain"],
      cwd: workspace.worktreePath,
      timeoutMs: 30_000,
      env: projectEnvironment,
    });
    if (status.stdout.trim().length === 0) {
      throw new Error("Codex 没有产生代码改动，任务已停止");
    }

    input.onProgress("代码已修改，正在运行测试");
    await this.#dependencies.runCommand({
      command: command(config.repository.testCommand),
      cwd: workspace.worktreePath,
      timeoutMs: TEST_TIMEOUT_MS,
      env: projectEnvironment,
    });

    input.onProgress("测试通过，正在构建 Electron 安装包");
    await this.#dependencies.runCommand({
      command: command(config.repository.buildCommand),
      cwd: workspace.worktreePath,
      timeoutMs: BUILD_TIMEOUT_MS,
      env: projectEnvironment,
    });
    const artifactPath = await this.#dependencies.findArtifact(
      workspace.worktreePath,
      config.repository.artifactGlobs,
    );

    if (config.git.commitChanges) {
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
          command: ["git", "push", "--set-upstream", config.repository.remote, branchName],
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

    input.onProgress("构建完成，正在上传安装包");
    const artifact = await this.#dependencies.publisher.publish(artifactPath, input.taskId);
    input.onProgress("安装包已上传，正在发送结果");
    return {
      taskId: input.taskId,
      branchName,
      commitHash: commit.stdout.trim(),
      codexSummary: codexResult.finalMessage,
      artifact,
    };
  }
}
