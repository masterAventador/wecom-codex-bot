import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";

import { findNewestArtifact } from "../src/artifact-locator.ts";
import { FilesystemArtifactPublisher } from "../src/artifact-publisher.ts";
import { runCodex } from "../src/codex-runner.ts";
import type { BotConfig } from "../src/config.ts";
import { prepareGitWorkspace } from "../src/git-workspace.ts";
import { runCommand } from "../src/process-runner.ts";
import { TaskWorkflow } from "../src/task-workflow.ts";

const execFileAsync = promisify(execFile);
const runRealCodex = process.env.RUN_LOCAL_CODEX_E2E === "1";
const runLocalPipeline = process.env.RUN_LOCAL_PIPELINE_E2E === "1";

it(
  "本地任务流水线完成代码修改、测试、构建和 115MB 制品发布",
  { skip: !runRealCodex && !runLocalPipeline, timeout: 15 * 60_000 },
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "wecom-codex-e2e-"));
    const repositoryPath = join(temporaryRoot, "electron-app");
    const publishedDirectory = join(temporaryRoot, "published");
    const fakeCodexPath = join(temporaryRoot, "fake-codex");
    await mkdir(join(repositoryPath, "src"), { recursive: true });
    await mkdir(join(repositoryPath, "test"), { recursive: true });

    try {
      await writeFile(
        join(repositoryPath, "package.json"),
        JSON.stringify(
          {
            name: "electron-sample",
            private: true,
            type: "module",
            scripts: {
              test: "node --test",
              dist: "node build.js",
            },
          },
          null,
          2,
        ),
      );
      await writeFile(join(repositoryPath, ".gitignore"), "node_modules/\nrelease/\n");
      await writeFile(join(repositoryPath, "src", "sum.js"), "export const sum = (a, b) => a - b;\n");
      await writeFile(
        join(repositoryPath, "test", "sum.test.js"),
        `import assert from "node:assert/strict";
import { test } from "node:test";
import { sum } from "../src/sum.js";
test("sum adds two numbers", () => assert.equal(sum(2, 3), 5));
`,
      );
      await writeFile(
        join(repositoryPath, "build.js"),
        `import { closeSync, ftruncateSync, mkdirSync, openSync } from "node:fs";
mkdirSync("release", { recursive: true });
const file = openSync("release/Sample Electron App.dmg", "w");
ftruncateSync(file, 115 * 1024 * 1024);
closeSync(file);
`,
      );
      if (!runRealCodex) {
        await writeFile(
          fakeCodexPath,
          `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync("src/sum.js", "export const sum = (a, b) => a + b;\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"已修复 sum 并通过回归测试"}}));
});
`,
          { mode: 0o755 },
        );
      }
      await execFileAsync("git", ["init", "--initial-branch=dev", repositoryPath]);
      await execFileAsync("git", ["config", "user.name", "E2E Test"], { cwd: repositoryPath });
      await execFileAsync("git", ["config", "user.email", "e2e@example.com"], { cwd: repositoryPath });
      await execFileAsync("git", ["add", "-A"], { cwd: repositoryPath });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repositoryPath });

      const config: BotConfig = {
        projects: {
          "electron-sample": {
            path: repositoryPath,
            baseBranch: "dev",
            remote: "origin",
            fetchBeforeTask: false,
            installCommand: ["npm", "install", "--ignore-scripts"],
            testCommand: ["npm", "test"],
            buildCommand: ["npm", "run", "dist"],
            artifactGlobs: ["release/*.dmg"],
          },
        },
        permissionGroups: [{
          name: "端到端测试组",
          allowedUserIds: ["owner"],
          allowedChatIds: ["group"],
          allowedProjectIds: ["electron-sample"],
        }],
        codex: {
          binary: runRealCodex ? "/opt/homebrew/bin/codex" : fakeCodexPath,
          timeoutMinutes: 10,
        },
        git: {
          commitChanges: true,
          pushBranches: false,
          branchPrefix: "bot",
          authorName: "企微修复机器人",
          authorEmail: "wecom-codex-bot@localhost",
        },
        runtime: { directory: join(temporaryRoot, "runtime") },
        artifact: {
          provider: "filesystem",
          filesystem: {
            directory: publishedDirectory,
            downloadBaseUrl: "http://127.0.0.1:18080/artifacts",
          },
        },
      };
      if (config.artifact.provider !== "filesystem") {
        throw new Error("端到端测试必须使用本地制品发布器");
      }
      const workflow = new TaskWorkflow({
        prepareWorkspace: prepareGitWorkspace,
        runCommand,
        runCodex,
        findArtifact: findNewestArtifact,
        publisher: new FilesystemArtifactPublisher(config.artifact.filesystem),
      });

      const result = await workflow.run({
        taskId: "e2e-task",
        projectId: "electron-sample",
        prompt: "sum 函数错误地做了减法，请修复为加法，确保现有回归测试通过。",
        imagePaths: [],
        filePaths: [],
        config,
        onProgress: () => undefined,
      });

      assert.equal(result.projectId, "electron-sample");
      assert.equal(result.branchName, "bot/e2e-task");
      assert.match(result.commitHash, /^[a-f0-9]+$/);
      assert.equal(result.artifact.sizeBytes, 115 * 1024 * 1024);
      assert.equal((await stat(join(publishedDirectory, "e2e-task", "Sample Electron App.dmg"))).size, 115 * 1024 * 1024);
      assert.match(result.artifact.downloadUrl, /Sample%20Electron%20App\.dmg$/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);
