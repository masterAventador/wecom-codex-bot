import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "./process-runner.ts";

type PrepareGitWorkspaceOptions = {
  repositoryPath: string;
  baseBranch: string;
  remote: string;
  fetchBeforeTask: boolean;
  branchName: string;
  worktreeName: string;
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
