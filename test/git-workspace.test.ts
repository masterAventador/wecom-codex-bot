import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { prepareGitWorkspace } from "../src/git-workspace.ts";

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
});
