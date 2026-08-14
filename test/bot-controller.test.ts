import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BotConfig } from "../src/config.ts";
import { BotController } from "../src/bot-controller.ts";

const project = {
  path: "/tmp/repository",
  baseBranch: "dev",
  remote: "origin",
  fetchBeforeTask: false,
  installCommand: ["npm", "ci"],
  testCommand: ["npm", "test"],
  buildCommand: ["npm", "run", "dist"],
  artifactGlobs: ["release/*.dmg"],
};

const config: BotConfig = {
  projects: {
    "desktop-client": project,
    "admin-panel": { ...project, path: "/tmp/admin-panel" },
  },
  permissionGroups: [
    {
      name: "单项目测试组",
      allowedUserIds: ["tester"],
      allowedChatIds: ["group-1"],
      allowedProjectIds: ["desktop-client"],
    },
    {
      name: "管理员组",
      allowedUserIds: ["owner"],
      allowedChatIds: ["group-1"],
      allowedProjectIds: ["desktop-client", "admin-panel"],
    },
  ],
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

function message(overrides: Record<string, unknown> = {}) {
  const replies: string[] = [];
  const notifications: string[] = [];
  return {
    input: {
      msgId: "msg-1",
      userId: "owner",
      chatId: "group-1",
      content: "/fix desktop-client 修复白屏",
      materializeAttachments: async () => [] as string[],
      cleanupAttachments: async () => undefined,
      reply: async (text: string) => {
        replies.push(text);
      },
      notify: async (text: string) => {
        notifications.push(text);
      },
      ...overrides,
    },
    replies,
    notifications,
  };
}

function successResult(taskId: string, projectId = "desktop-client") {
  return {
    taskId,
    projectId,
    branchName: "bot/task-001",
    commitHash: "abc1234",
    codexSummary: "完成",
    artifact: {
      filename: "App.dmg",
      downloadUrl: "https://example/App.dmg",
      sizeBytes: 115 * 1024 * 1024,
      sha256: "a".repeat(64),
    },
  };
}

describe("企微消息控制器", () => {
  it("未授权用户只能得到自己的 userid，不会创建任务", async () => {
    let workflowRuns = 0;
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { run: async () => { workflowRuns += 1; throw new Error("不应执行"); } },
    });
    const current = message({ userId: "visitor" });

    const result = await controller.handle(current.input);

    assert.equal(result.kind, "denied");
    assert.match(current.replies[0] ?? "", /visitor/);
    assert.equal(workflowRuns, 0);
  });

  it("/whoami 返回 userid 和 chatid，不创建任务", async () => {
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { run: async () => { throw new Error("不应执行"); } },
    });
    const current = message({ content: "/whoami", userId: "visitor", chatId: "other-group" });

    const result = await controller.handle(current.input);

    assert.equal(result.kind, "identity");
    assert.match(current.replies[0] ?? "", /visitor/);
    assert.match(current.replies[0] ?? "", /other-group/);
  });

  it("/projects 只返回该用户在当前群有权操作的项目", async () => {
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { run: async () => { throw new Error("不应执行"); } },
    });
    const current = message({ content: "/projects" });

    const result = await controller.handle(current.input);

    assert.equal(result.kind, "projects");
    assert.match(current.replies[0] ?? "", /admin-panel/);
    assert.match(current.replies[0] ?? "", /desktop-client/);
  });

  it("多项目用户未指定项目时只提示选择，不创建任务", async () => {
    let workflowRuns = 0;
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { run: async () => { workflowRuns += 1; throw new Error("不应执行"); } },
    });
    const current = message({ content: "修复白屏" });

    const result = await controller.handle(current.input);

    assert.equal(result.kind, "project-required");
    assert.match(current.replies[0] ?? "", /\/fix <项目ID> <问题描述>/);
    assert.equal(workflowRuns, 0);
  });

  it("无权访问指定项目时返回当前可用项目", async () => {
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { run: async () => { throw new Error("不应执行"); } },
    });
    const current = message({
      userId: "tester",
      content: "/fix admin-panel 修复权限页",
    });

    const result = await controller.handle(current.input);

    assert.equal(result.kind, "denied");
    assert.match(current.replies[0] ?? "", /admin-panel/);
    assert.match(current.replies[0] ?? "", /desktop-client/);
  });

  it("授权消息把选定项目传入流水线，附件只在真正执行时下载", async () => {
    const events: string[] = [];
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: {
        async run(input) {
          events.push(`workflow:${input.projectId}:${input.imagePaths.join(",")}`);
          return successResult(input.taskId, input.projectId);
        },
      },
    });
    const current = message({
      materializeAttachments: async () => {
        events.push("attachments");
        return ["/tmp/screenshot.png"];
      },
      cleanupAttachments: async () => {
        events.push("cleanup");
      },
    });

    const result = await controller.handle(current.input);
    assert.equal(result.kind, "queued");
    assert.match(current.replies[0] ?? "", /desktop-client/);
    if (result.kind !== "queued") throw new Error("任务未入队");
    await result.completion;

    assert.deepEqual(events, [
      "attachments",
      "workflow:desktop-client:/tmp/screenshot.png",
      "cleanup",
    ]);
    assert.match(current.notifications.at(-1) ?? "", /项目：desktop-client/);
    assert.match(current.notifications.at(-1) ?? "", /https:\/\/example\/App.dmg/);
  });

  it("只有一个授权项目时仍兼容直接发送问题描述", async () => {
    let selectedProject = "";
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: {
        async run(input) {
          selectedProject = input.projectId;
          return successResult(input.taskId, input.projectId);
        },
      },
    });
    const current = message({ userId: "tester", content: "修复白屏" });

    const result = await controller.handle(current.input);
    if (result.kind !== "queued") throw new Error("任务未入队");
    await result.completion;

    assert.equal(selectedProject, "desktop-client");
  });

  it("相同 msgid 只执行一次", async () => {
    let runs = 0;
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: {
        async run(input) {
          runs += 1;
          return successResult(input.taskId, input.projectId);
        },
      },
    });
    const first = message();
    const second = message();

    const firstResult = await controller.handle(first.input);
    if (firstResult.kind === "queued") await firstResult.completion;
    const secondResult = await controller.handle(second.input);

    assert.equal(secondResult.kind, "duplicate");
    assert.equal(runs, 1);
  });
});
