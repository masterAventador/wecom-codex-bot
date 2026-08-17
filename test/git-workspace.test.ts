import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { mergeGitWorkspace, prepareGitWorkspace } from "../src/git-workspace.ts";

const execFileAsync = promisify(execFile);

describe("Git 隔离工作区", () => {
  it("在仓库 wt 目录创建独立分支并写入本地 exclude", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "wecom-codex-git-"));
    const repositoryPath = join(temporaryRoot, "repository");

    try {
      await execFileAsync("git", ["init", "--initial-branch=dev", repositoryPath]);
      await execFileAsync("git", ["config", "user.name", "Bot Test"], { cwd: repositoryPath });
      await execFileAsync("git", ["config", "user.email", "bot@example.com"], { cwd: repositoryPath });
      await writeFile(join(repositoryPath, "README.md"), "initial\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repositoryPath });

      const result = await prepareGitWorkspace({
        repositoryPath,
        baseBranch: "dev",
        remote: "origin",
        fetchBeforeTask: false,
        branchName: "bot/task-001",
        worktreeName: "task-001",
      });

      assert.equal(result.worktreePath, join(repositoryPath, "wt", "task-001"));
      assert.equal(
        (await execFileAsync("git", ["branch", "--show-current"], { cwd: result.worktreePath })).stdout.trim(),
        "bot/task-001",
      );
      assert.match(await readFile(join(repositoryPath, ".git", "info", "exclude"), "utf8"), /^\/wt\/$/m);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("把成功任务快进合并到 dev，然后删除 worktree 和任务分支", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "wecom-codex-merge-"));
    const repositoryPath = join(temporaryRoot, "repository");

    try {
      await execFileAsync("git", ["init", "--initial-branch=dev", repositoryPath]);
      await execFileAsync("git", ["config", "user.name", "Bot Test"], { cwd: repositoryPath });
      await execFileAsync("git", ["config", "user.email", "bot@example.com"], { cwd: repositoryPath });
      await writeFile(join(repositoryPath, "README.md"), "initial\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repositoryPath });
      const workspace = await prepareGitWorkspace({
        repositoryPath,
        baseBranch: "dev",
        remote: "origin",
        fetchBeforeTask: false,
        branchName: "bot/task-merge",
        worktreeName: "task-merge",
      });
      await writeFile(join(workspace.worktreePath, "README.md"), "changed\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: workspace.worktreePath });
      await execFileAsync("git", ["commit", "-m", "changed"], { cwd: workspace.worktreePath });

      await mergeGitWorkspace({
        repositoryPath,
        baseBranch: "dev",
        taskBranch: workspace.branchName,
        worktreePath: workspace.worktreePath,
      });

      assert.equal(await readFile(join(repositoryPath, "README.md"), "utf8"), "changed\n");
      assert.equal(
        (await execFileAsync("git", ["branch", "--show-current"], { cwd: repositoryPath })).stdout.trim(),
        "dev",
      );
      await assert.rejects(access(workspace.worktreePath));
      assert.doesNotMatch(
        (await execFileAsync("git", ["branch", "--list", "bot/task-merge"], { cwd: repositoryPath })).stdout,
        /bot\/task-merge/,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("基础仓库未检出 dev 时拒绝合并并保留任务现场", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "wecom-codex-merge-wrong-branch-"));
    const repositoryPath = join(temporaryRoot, "repository");

    try {
      await execFileAsync("git", ["init", "--initial-branch=dev", repositoryPath]);
      await execFileAsync("git", ["config", "user.name", "Bot Test"], { cwd: repositoryPath });
      await execFileAsync("git", ["config", "user.email", "bot@example.com"], { cwd: repositoryPath });
      await writeFile(join(repositoryPath, "README.md"), "initial\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repositoryPath });
      await execFileAsync("git", ["switch", "-c", "other"], { cwd: repositoryPath });
      const workspace = await prepareGitWorkspace({
        repositoryPath,
        baseBranch: "dev",
        remote: "origin",
        fetchBeforeTask: false,
        branchName: "bot/task-kept",
        worktreeName: "task-kept",
      });

      await assert.rejects(
        mergeGitWorkspace({
          repositoryPath,
          baseBranch: "dev",
          taskBranch: workspace.branchName,
          worktreePath: workspace.worktreePath,
        }),
        /必须检出 dev/,
      );
      await access(workspace.worktreePath);
      assert.match(
        (await execFileAsync("git", ["branch", "--list", "bot/task-kept"], { cwd: repositoryPath })).stdout,
        /bot\/task-kept/,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
