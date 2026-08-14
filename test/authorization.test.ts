import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorizeMessage } from "../src/authorization.ts";
import { classifyMessage } from "../src/message.ts";

const security = {
  allowedUserIds: ["owner", "tester"],
  allowedChatIds: ["weekend-feedback"],
};

describe("消息分类与白名单", () => {
  it("允许任何人用 /whoami 查询自己的 userid 和当前 chatid，但不触发任务", () => {
    const command = classifyMessage("  /whoami  ");
    const decision = authorizeMessage(security, {
      command,
      userId: "unknown-user",
      chatId: "unknown-chat",
    });

    assert.deepEqual(decision, {
      kind: "identity",
      userId: "unknown-user",
      chatId: "unknown-chat",
    });
  });

  it("群消息保留 @机器人 前缀时仍能识别 /whoami", () => {
    assert.deepEqual(classifyMessage("@代码机器人 /whoami"), { kind: "identity" });
  });

  it("先拒绝不在群白名单中的任务", () => {
    const decision = authorizeMessage(security, {
      command: classifyMessage("修复启动白屏"),
      userId: "owner",
      chatId: "another-group",
    });

    assert.deepEqual(decision, { kind: "denied", reason: "chat" });
  });

  it("拒绝群内未授权用户，并返回该用户自己的 userid", () => {
    const decision = authorizeMessage(security, {
      command: classifyMessage("修复启动白屏"),
      userId: "visitor",
      chatId: "weekend-feedback",
    });

    assert.deepEqual(decision, {
      kind: "denied",
      reason: "user",
      userId: "visitor",
    });
  });

  it("只允许用户和群都命中白名单的任务", () => {
    const decision = authorizeMessage(security, {
      command: classifyMessage("修复启动白屏"),
      userId: "tester",
      chatId: "weekend-feedback",
    });

    assert.deepEqual(decision, {
      kind: "allowed",
      prompt: "修复启动白屏",
    });
  });

  it("忽略空消息", () => {
    assert.deepEqual(classifyMessage("   "), { kind: "ignore" });
  });
});
