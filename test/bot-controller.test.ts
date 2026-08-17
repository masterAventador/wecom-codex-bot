import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BotConfig } from "../src/config.ts";
import { BotController } from "../src/bot-controller.ts";

const project = {
  displayName: "桌面客户端",
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
    "admin-panel": { ...project, displayName: "管理后台", path: "/tmp/admin-panel" },
  },
  permissionGroups: [
    {
      name: "单项目测试组",
      allowedUserIds: ["tester"],
      allowedChatIds: ["group-1"],
      allowDirectMessages: true,
      allowedProjectIds: ["desktop-client"],
    },
    {
      name: "管理员组",
      allowedUserIds: ["owner"],
      allowedChatIds: ["group-1"],
      allowDirectMessages: true,
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
  const cards: Array<{
    selectionId: string;
    projects: Array<{ projectId: string; displayName: string }>;
  }> = [];
  return {
    input: {
      msgId: "msg-1",
      userId: "owner",
      chatId: "group-1",
      content: "修复白屏",
      materializeAttachments: async () => ({ imagePaths: [] as string[], filePaths: [] as string[] }),
      cleanupAttachments: async () => undefined,
      reply: async (text: string) => {
        replies.push(text);
      },
      replyProjectSelection: async (
        selectionId: string,
        projects: Array<{ projectId: string; displayName: string }>,
      ) => {
        cards.push({ selectionId, projects });
      },
      notify: async (text: string) => {
        notifications.push(text);
      },
      ...overrides,
    },
    replies,
    notifications,
    cards,
  };
}

function selection(overrides: Record<string, unknown> = {}) {
  const updates: string[] = [];
  return {
    input: {
      selectionId: "select_task-001",
      projectId: "admin-panel",
      userId: "owner",
      chatId: "group-1",
      updateCard: async (text: string) => {
        updates.push(text);
      },
      ...overrides,
    },
    updates,
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

describe("自然对话消息控制器", () => {
  it("未授权用户得到自己的 userid，不会创建任务", async () => {
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

  it("只有一个授权项目时直接使用展示名称创建任务", async () => {
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
    const current = message({ userId: "tester", content: "登录按钮点了没反应" });

    const result = await controller.handle(current.input);
    assert.equal(result.kind, "queued");
    assert.match(current.replies[0] ?? "", /桌面客户端/);
    assert.doesNotMatch(current.replies[0] ?? "", /desktop-client/);
    if (result.kind !== "queued") throw new Error("任务未入队");
    await result.completion;

    assert.equal(selectedProject, "desktop-client");
    assert.match(current.notifications.at(-1) ?? "", /项目：桌面客户端/);
  });

  it("单聊没有 chatid 时也能按 allowDirectMessages 创建任务", async () => {
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { async run(input) { return successResult(input.taskId, input.projectId); } },
    });
    const current = message({ userId: "tester", chatId: undefined, content: "启动后白屏" });

    const result = await controller.handle(current.input);
    if (result.kind !== "queued") throw new Error("单聊任务未入队");
    await result.completion;

    assert.match(current.replies[0] ?? "", /桌面客户端/);
    assert.match(current.notifications.at(-1) ?? "", /下载安装包/);
  });

  it("有多个授权项目时保存原问题并回复展示名称选择卡片", async () => {
    let workflowRuns = 0;
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { run: async () => { workflowRuns += 1; throw new Error("不应执行"); } },
    });
    const current = message({ content: "修复权限页面" });

    const result = await controller.handle(current.input);

    assert.deepEqual(result, { kind: "project-selection", selectionId: "select_task-001" });
    assert.deepEqual(current.cards, [{
      selectionId: "select_task-001",
      projects: [
        { projectId: "admin-panel", displayName: "管理后台" },
        { projectId: "desktop-client", displayName: "桌面客户端" },
      ],
    }]);
    assert.equal(workflowRuns, 0);
  });

  it("企微重试同一条消息时不会重复发送项目选择卡片", async () => {
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { run: async () => { throw new Error("不应执行"); } },
    });
    const first = message();
    const retried = message();

    assert.equal((await controller.handle(first.input)).kind, "project-selection");
    assert.equal((await controller.handle(retried.input)).kind, "duplicate");
    assert.equal(first.cards.length + retried.cards.length, 1);
  });

  it("同一会话匹配超过六个项目时明确提示企微卡片上限", async () => {
    const projectEntries = Array.from({ length: 7 }, (_, index) => {
      const number = index + 1;
      return [`project-${number}`, {
        ...project,
        displayName: `项目${number}`,
        path: `/tmp/project-${number}`,
      }] as const;
    });
    const oversizedConfig: BotConfig = {
      ...config,
      projects: Object.fromEntries(projectEntries),
      permissionGroups: [{
        name: "超大权限组",
        allowedUserIds: ["owner"],
        allowedChatIds: ["group-1"],
        allowDirectMessages: true,
        allowedProjectIds: projectEntries.map(([projectId]) => projectId),
      }],
    };
    const controller = new BotController({
      loadConfig: async () => oversizedConfig,
      createTaskId: () => "task-001",
      workflow: { run: async () => { throw new Error("不应执行"); } },
    });
    const current = message();

    assert.equal((await controller.handle(current.input)).kind, "denied");
    assert.match(current.replies[0] ?? "", /最多.*6.*项目/);
    assert.equal(current.cards.length, 0);
  });

  it("项目选择卡片发送失败后允许企微重试", async () => {
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { run: async () => { throw new Error("不应执行"); } },
    });
    const failed = message({
      replyProjectSelection: async () => { throw new Error("网络中断"); },
    });

    await assert.rejects(controller.handle(failed.input), /网络中断/);
    assert.equal((await controller.handleProjectSelection(selection().input)).kind, "expired");
    assert.equal((await controller.handle(message().input)).kind, "project-selection");
  });

  it("点击项目卡片后重新鉴权，并使用原问题和原附件启动任务", async () => {
    const events: string[] = [];
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: {
        async run(input) {
          events.push(`${input.projectId}:${input.prompt}:${input.imagePaths.join(",")}`);
          return successResult(input.taskId, input.projectId);
        },
      },
    });
    const current = message({
      content: "修复权限页面",
      materializeAttachments: async () => {
        events.push("attachments");
        return { imagePaths: ["/tmp/screenshot.png"], filePaths: [] };
      },
      cleanupAttachments: async () => {
        events.push("cleanup");
      },
    });
    await controller.handle(current.input);
    const clicked = selection();

    const result = await controller.handleProjectSelection(clicked.input);
    assert.equal(result.kind, "queued");
    assert.match(clicked.updates[0] ?? "", /管理后台/);
    if (result.kind !== "queued") throw new Error("选择项目后任务未入队");
    await result.completion;

    assert.deepEqual(events, [
      "attachments",
      "admin-panel:修复权限页面:/tmp/screenshot.png",
      "cleanup",
    ]);
    assert.match(current.notifications.at(-1) ?? "", /项目：管理后台/);
  });

  it("其他用户或其他会话不能点击别人的项目选择卡片", async () => {
    let workflowRuns = 0;
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { run: async () => { workflowRuns += 1; throw new Error("不应执行"); } },
    });
    await controller.handle(message().input);
    const otherUser = selection({ userId: "tester" });
    const otherChat = selection({ chatId: "group-2" });

    assert.equal((await controller.handleProjectSelection(otherUser.input)).kind, "denied");
    assert.equal((await controller.handleProjectSelection(otherChat.input)).kind, "denied");
    assert.match(otherUser.updates[0] ?? "", /无权/);
    assert.match(otherChat.updates[0] ?? "", /无权/);
    assert.equal(workflowRuns, 0);
  });

  it("不存在或已经使用过的选择卡片不会重复执行", async () => {
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
    const missing = selection({ selectionId: "select_missing" });
    assert.equal((await controller.handleProjectSelection(missing.input)).kind, "expired");
    assert.match(missing.updates[0] ?? "", /失效/);

    await controller.handle(message().input);
    const clicked = selection();
    const first = await controller.handleProjectSelection(clicked.input);
    if (first.kind === "queued") await first.completion;
    const second = await controller.handleProjectSelection(selection().input);

    assert.equal(second.kind, "expired");
    assert.equal(runs, 1);
  });

  it("五分钟未选择的卡片会失效并允许原消息重新生成卡片", async () => {
    let now = 1_000;
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      now: () => now,
      workflow: { run: async () => { throw new Error("不应执行"); } },
    });
    await controller.handle(message().input);
    now += 5 * 60 * 1_000 + 1;

    const expired = await controller.handleProjectSelection(selection().input);
    const retried = await controller.handle(message().input);

    assert.equal(expired.kind, "expired");
    assert.equal(retried.kind, "project-selection");
  });

  it("入队回执失败时仍会发送最终任务通知", async () => {
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: { async run(input) { return successResult(input.taskId, input.projectId); } },
    });
    const current = message({
      userId: "tester",
      reply: async () => { throw new Error("回执失败"); },
    });

    await assert.rejects(controller.handle(current.input), /回执失败/);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.match(current.notifications.at(-1) ?? "", /修复完成/);
  });
});
