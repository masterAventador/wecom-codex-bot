import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { runCommand } from "./process-runner.ts";

type PrepareGitWorkspaceOptions = {
  repositoryPath: string;
  baseBranch: string;
  remote: string;
  fetchBeforeTask: boolean;
  branchName: string;
  worktreeName: string;
};

type MergeGitWorkspaceOptions = {
  repositoryPath: string;
  baseBranch: string;
  taskBranch: string;
  worktreePath: string;
};

export type GitWorkspace = {
  branchName: string;
  worktreePath: string;
};

const LOCAL_EXCLUDE_ENTRY = "/wt/";

async function ensureWorktreeExcluded(repositoryPath: string): Promise<void> {
  const excludePath = join(repositoryPath, ".git", "info", "exclude");
  const current = await readFile(excludePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (!current.split(/\r?\n/).includes(LOCAL_EXCLUDE_ENTRY)) {
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${separator}${LOCAL_EXCLUDE_ENTRY}\n`);
  }
}

export async function prepareGitWorkspace(
  options: PrepareGitWorkspaceOptions,
): Promise<GitWorkspace> {
  if (!/^[a-zA-Z0-9._-]+$/.test(options.worktreeName)) {
    throw new Error("worktreeName 含有不安全字符");
  }

  const worktreeRoot = join(options.repositoryPath, "wt");
  const worktreePath = join(worktreeRoot, options.worktreeName);
  await ensureWorktreeExcluded(options.repositoryPath);
  await mkdir(worktreeRoot, { recursive: true });

  let startRef = options.baseBranch;
  if (options.fetchBeforeTask) {
    await runCommand({
      command: ["git", "fetch", options.remote, options.baseBranch],
      cwd: options.repositoryPath,
      timeoutMs: 120_000,
    });
    startRef = `${options.remote}/${options.baseBranch}`;
  }

  await runCommand({
    command: ["git", "worktree", "add", "-b", options.branchName, worktreePath, startRef],
    cwd: options.repositoryPath,
    timeoutMs: 120_000,
  });

  return { branchName: options.branchName, worktreePath };
}

function assertTaskWorktreePath(repositoryPath: string, worktreePath: string): void {
  const worktreeRoot = resolve(repositoryPath, "wt");
  const candidate = resolve(worktreePath);
  const relativePath = relative(worktreeRoot, candidate);
  if (
    relativePath.length === 0
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(`拒绝清理不在项目 wt 目录内的路径：${worktreePath}`);
  }
}

export async function mergeGitWorkspace(options: MergeGitWorkspaceOptions): Promise<void> {
  assertTaskWorktreePath(options.repositoryPath, options.worktreePath);

  const baseBranch = await runCommand({
    command: ["git", "branch", "--show-current"],
    cwd: options.repositoryPath,
    timeoutMs: 30_000,
  });
  if (baseBranch.stdout.trim() !== options.baseBranch) {
    throw new Error(`基础仓库必须检出 ${options.baseBranch}，当前是 ${baseBranch.stdout.trim() || "游离 HEAD"}`);
  }

  const baseStatus = await runCommand({
    command: ["git", "status", "--porcelain"],
    cwd: options.repositoryPath,
    timeoutMs: 30_000,
  });
  if (baseStatus.stdout.trim().length > 0) {
    throw new Error(`基础仓库工作区不干净，无法合并到 ${options.baseBranch}`);
  }

  const taskBranch = await runCommand({
    command: ["git", "branch", "--show-current"],
    cwd: options.worktreePath,
    timeoutMs: 30_000,
  });
  if (taskBranch.stdout.trim() !== options.taskBranch) {
    throw new Error(`任务 worktree 分支不匹配：预期 ${options.taskBranch}，实际 ${taskBranch.stdout.trim() || "游离 HEAD"}`);
  }

  const taskStatus = await runCommand({
    command: ["git", "status", "--porcelain"],
    cwd: options.worktreePath,
    timeoutMs: 30_000,
  });
  if (taskStatus.stdout.trim().length > 0) {
    throw new Error(`任务分支 ${options.taskBranch} 仍有未提交修改，已保留 worktree`);
  }

  await runCommand({
    command: ["git", "merge", "--ff-only", options.taskBranch],
    cwd: options.repositoryPath,
    timeoutMs: 120_000,
  });
  await runCommand({
    command: ["git", "worktree", "remove", "--force", resolve(options.worktreePath)],
    cwd: options.repositoryPath,
    timeoutMs: 120_000,
  });
  await runCommand({
    command: ["git", "branch", "-d", options.taskBranch],
    cwd: options.repositoryPath,
    timeoutMs: 30_000,
  });
}
