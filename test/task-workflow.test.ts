import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BotConfig } from "../src/config.ts";
import type { PublishedArtifact } from "../src/artifact-publisher.ts";
import { createSafeProjectEnvironment, TaskWorkflow } from "../src/task-workflow.ts";

const config: BotConfig = {
  projects: {
    "desktop-client": {
      path: "/tmp/repository",
      baseBranch: "dev",
      remote: "origin",
      fetchBeforeTask: false,
      installCommand: ["npm", "ci"],
      testCommand: ["npm", "test"],
      buildCommand: ["npm", "run", "dist"],
      artifactGlobs: ["release/*.dmg"],
    },
  },
  permissionGroups: [{
    name: "支持组",
    allowedUserIds: ["owner"],
    allowedChatIds: ["group"],
    allowedProjectIds: ["desktop-client"],
  }],
  codex: { binary: "codex", timeoutMinutes: 45 },
  git: {
    commitChanges: true,
    pushBranches: false,
    branchPrefix: "bot",
    authorName: "企微修复机器人",
    authorEmail: "wecom-codex-bot@localhost",
  },
  runtime: { directory: "/tmp/runtime" },
  artifact: {
    provider: "filesystem",
    filesystem: {
      directory: "/tmp/artifacts",
      downloadBaseUrl: "http://localhost/artifacts",
    },
  },
};

const publishedArtifact: PublishedArtifact = {
  filename: "App.dmg",
  downloadUrl: "https://download.example/App.dmg",
  sizeBytes: 115 * 1024 * 1024,
  sha256: "a".repeat(64),
};

describe("修复任务流水线", () => {
  it("项目命令环境不包含企微和对象存储密钥", () => {
    assert.deepEqual(
      createSafeProjectEnvironment({
        PATH: "/usr/bin",
        SIGNING_PASSWORD: "keep-for-build",
        WECOM_BOT_SECRET: "remove",
        COS_SECRET_ID: "remove",
        COS_SECRET_KEY: "remove",
      }),
      {
        PATH: "/usr/bin",
        SIGNING_PASSWORD: "keep-for-build",
      },
    );
  });

  it("依次安装依赖、调用 Codex、测试、构建、提交并发布安装包", async () => {
    const events: string[] = [];
    const commands: string[][] = [];
    const workflow = new TaskWorkflow({
      async prepareWorkspace(options) {
        assert.equal(options.repositoryPath, "/tmp/repository");
        events.push(`workspace:${options.branchName}`);
        return { branchName: options.branchName, worktreePath: "/tmp/repository/wt/task-001" };
      },
      async runCommand(options) {
        commands.push([...options.command]);
        if (options.command[0] === "git" && options.command[1] === "status") {
          return { stdout: " M src/main.ts\n", stderr: "", exitCode: 0 };
        }
        if (options.command[0] === "git" && options.command[1] === "rev-parse") {
          return { stdout: "abc1234\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async runCodex(options) {
        events.push("codex");
        assert.deepEqual(options.imagePaths, ["/tmp/screenshot.png"]);
        assert.match(options.prompt, /仅作为问题描述/);
        return { finalMessage: "已修复启动白屏", stderr: "" };
      },
      async findArtifact() {
        events.push("artifact:find");
        return "/tmp/repository/wt/task-001/release/App.dmg";
      },
      publisher: {
        async publish() {
          events.push("artifact:publish");
          return publishedArtifact;
        },
      },
    });
    const progress: string[] = [];

    const result = await workflow.run({
      taskId: "task-001",
      projectId: "desktop-client",
      prompt: "修复启动白屏",
      imagePaths: ["/tmp/screenshot.png"],
      config,
      onProgress: (message) => progress.push(message),
    });

    assert.equal(result.projectId, "desktop-client");
    assert.equal(result.branchName, "bot/task-001");
    assert.equal(result.commitHash, "abc1234");
    assert.equal(result.artifact.downloadUrl, publishedArtifact.downloadUrl);
    assert.deepEqual(commands, [
      ["npm", "ci"],
      ["git", "status", "--porcelain"],
      ["npm", "test"],
      ["npm", "run", "dist"],
      ["git", "add", "-A"],
      ["git", "commit", "-m", "fix(bot): 修复启动白屏"],
      ["git", "rev-parse", "--short", "HEAD"],
    ]);
    assert.deepEqual(events, [
      "workspace:bot/task-001",
      "codex",
      "artifact:find",
      "artifact:publish",
    ]);
    assert.match(progress.at(-1) ?? "", /安装包已上传/);
  });

  it("测试失败时不构建也不发布", async () => {
    let published = false;
    const commands: string[][] = [];
    const workflow = new TaskWorkflow({
      async prepareWorkspace(options) {
        return { branchName: options.branchName, worktreePath: "/tmp/worktree" };
      },
      async runCommand(options) {
        commands.push([...options.command]);
        if (options.command[0] === "git") {
          return { stdout: " M src/main.ts\n", stderr: "", exitCode: 0 };
        }
        if (options.command[0] === "npm" && options.command[1] === "test") {
          throw new Error("tests failed");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async runCodex() {
        return { finalMessage: "changed", stderr: "" };
      },
      async findArtifact() {
        throw new Error("不应执行");
      },
      publisher: {
        async publish() {
          published = true;
          return publishedArtifact;
        },
      },
    });

    await assert.rejects(
      workflow.run({
        taskId: "task-002",
        projectId: "desktop-client",
        prompt: "修复问题",
        imagePaths: [],
        config,
        onProgress: () => undefined,
      }),
      /tests failed/,
    );
    assert.equal(published, false);
    assert.equal(commands.some((command) => command[2] === "dist"), false);
  });

  it("开启 pushBranches 后把任务分支推送到配置的远端", async () => {
    const commands: string[][] = [];
    const pushConfig = structuredClone(config);
    pushConfig.git.pushBranches = true;
    const workflow = new TaskWorkflow({
      async prepareWorkspace(options) {
        return { branchName: options.branchName, worktreePath: "/tmp/worktree" };
      },
      async runCommand(options) {
        commands.push([...options.command]);
        if (options.command[1] === "status") {
          return { stdout: " M src/main.ts\n", stderr: "", exitCode: 0 };
        }
        if (options.command[1] === "rev-parse") {
          return { stdout: "abc1234\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async runCodex() {
        return { finalMessage: "完成", stderr: "" };
      },
      async findArtifact() {
        return "/tmp/App.dmg";
      },
      publisher: { async publish() { return publishedArtifact; } },
    });

    await workflow.run({
      taskId: "task-push",
      projectId: "desktop-client",
      prompt: "修复问题",
      imagePaths: [],
      config: pushConfig,
      onProgress: () => undefined,
    });

    assert.equal(
      commands.some((value) =>
        value.join(" ") === "git push --set-upstream origin bot/task-push"),
      true,
    );
  });

  it("拒绝执行未在配置中登记的项目", async () => {
    const workflow = new TaskWorkflow({
      async prepareWorkspace() { throw new Error("不应执行"); },
      async runCommand() { throw new Error("不应执行"); },
      async runCodex() { throw new Error("不应执行"); },
      async findArtifact() { throw new Error("不应执行"); },
      publisher: { async publish() { throw new Error("不应执行"); } },
    });

    await assert.rejects(
      workflow.run({
        taskId: "task-unknown",
        projectId: "not-registered",
        prompt: "修复问题",
        imagePaths: [],
        config,
        onProgress: () => undefined,
      }),
      /项目未登记：not-registered/,
    );
  });
});
