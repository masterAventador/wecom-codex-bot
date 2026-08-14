import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BotConfig } from "../src/config.ts";
import { BotController } from "../src/bot-controller.ts";

const config = {
  security: { allowedUserIds: ["owner"], allowedChatIds: ["group-1"] },
} as BotConfig;

function message(overrides: Record<string, unknown> = {}) {
  const replies: string[] = [];
  const notifications: string[] = [];
  return {
    input: {
      msgId: "msg-1",
      userId: "owner",
      chatId: "group-1",
      content: "修复白屏",
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

  it("授权消息进入串行队列，附件只在真正执行任务时下载", async () => {
    const events: string[] = [];
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: {
        async run(input) {
          events.push(`workflow:${input.imagePaths.join(",")}`);
          return {
            taskId: input.taskId,
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
    assert.match(current.replies[0] ?? "", /task-001/);
    if (result.kind !== "queued") throw new Error("任务未入队");
    await result.completion;

    assert.deepEqual(events, ["attachments", "workflow:/tmp/screenshot.png", "cleanup"]);
    assert.match(current.notifications.at(-1) ?? "", /https:\/\/example\/App.dmg/);
  });

  it("相同 msgid 只执行一次", async () => {
    let runs = 0;
    const controller = new BotController({
      loadConfig: async () => config,
      createTaskId: () => "task-001",
      workflow: {
        async run(input) {
          runs += 1;
          return {
            taskId: input.taskId,
            branchName: "bot/task-001",
            commitHash: "abc1234",
            codexSummary: "完成",
            artifact: {
              filename: "App.dmg",
              downloadUrl: "https://example/App.dmg",
              sizeBytes: 1,
              sha256: "a".repeat(64),
            },
          };
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
