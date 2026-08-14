import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorizeMessage } from "../src/authorization.ts";
import { classifyMessage } from "../src/message.ts";

const permissionGroups = [
  {
    name: "桌面端支持组",
    allowedUserIds: ["owner", "tester"],
    allowedChatIds: ["weekend-feedback"],
    allowedProjectIds: ["desktop-client"],
  },
  {
    name: "管理员组",
    allowedUserIds: ["owner"],
    allowedChatIds: ["weekend-feedback"],
    allowedProjectIds: ["desktop-client", "admin-panel"],
  },
];

describe("消息分类与项目权限组", () => {
  it("允许任何人用 /whoami 查询自己的 userid 和当前 chatid，但不触发任务", () => {
    const command = classifyMessage("  /whoami  ");
    const decision = authorizeMessage(permissionGroups, {
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

  it("群消息保留 @机器人 前缀时仍能识别命令", () => {
    assert.deepEqual(classifyMessage("@代码机器人 /whoami"), { kind: "identity" });
    assert.deepEqual(classifyMessage("@代码机器人 /projects"), { kind: "projects" });
    assert.deepEqual(classifyMessage("@代码机器人 /fix desktop-client 修复启动白屏"), {
      kind: "request",
      projectId: "desktop-client",
      prompt: "修复启动白屏",
    });
  });

  it("列出用户在当前群有权操作的项目并去重排序", () => {
    const decision = authorizeMessage(permissionGroups, {
      command: classifyMessage("/projects"),
      userId: "owner",
      chatId: "weekend-feedback",
    });

    assert.deepEqual(decision, {
      kind: "projects",
      projectIds: ["admin-panel", "desktop-client"],
    });
  });

  it("先拒绝没有任何权限组覆盖的群", () => {
    const decision = authorizeMessage(permissionGroups, {
      command: classifyMessage("/fix desktop-client 修复启动白屏"),
      userId: "owner",
      chatId: "another-group",
    });

    assert.deepEqual(decision, { kind: "denied", reason: "chat" });
  });

  it("拒绝当前群权限组中的未授权用户", () => {
    const decision = authorizeMessage(permissionGroups, {
      command: classifyMessage("/fix desktop-client 修复启动白屏"),
      userId: "visitor",
      chatId: "weekend-feedback",
    });

    assert.deepEqual(decision, {
      kind: "denied",
      reason: "user",
      userId: "visitor",
    });
  });

  it("明确指定项目时按 userid + chatid + projectId 三者交集授权", () => {
    const allowed = authorizeMessage(permissionGroups, {
      command: classifyMessage("/fix desktop-client 修复启动白屏"),
      userId: "tester",
      chatId: "weekend-feedback",
    });
    const denied = authorizeMessage(permissionGroups, {
      command: classifyMessage("/fix admin-panel 修复权限页"),
      userId: "tester",
      chatId: "weekend-feedback",
    });

    assert.deepEqual(allowed, {
      kind: "allowed",
      projectId: "desktop-client",
      prompt: "修复启动白屏",
    });
    assert.deepEqual(denied, {
      kind: "denied",
      reason: "project",
      projectId: "admin-panel",
      allowedProjectIds: ["desktop-client"],
    });
  });

  it("只有一个可用项目时允许省略 /fix 项目标识", () => {
    const decision = authorizeMessage(permissionGroups, {
      command: classifyMessage("修复启动白屏"),
      userId: "tester",
      chatId: "weekend-feedback",
    });

    assert.deepEqual(decision, {
      kind: "allowed",
      projectId: "desktop-client",
      prompt: "修复启动白屏",
    });
  });

  it("有多个可用项目但未指定时要求选择，不让机器人猜路径", () => {
    const decision = authorizeMessage(permissionGroups, {
      command: classifyMessage("修复启动白屏"),
      userId: "owner",
      chatId: "weekend-feedback",
    });

    assert.deepEqual(decision, {
      kind: "project-required",
      prompt: "修复启动白屏",
      projectIds: ["admin-panel", "desktop-client"],
    });
  });

  it("/fix 缺少项目或问题描述时返回用法提示", () => {
    assert.deepEqual(classifyMessage("/fix"), { kind: "usage" });
    assert.deepEqual(classifyMessage("/fix desktop-client"), { kind: "usage" });
  });

  it("忽略空消息", () => {
    assert.deepEqual(classifyMessage("   "), { kind: "ignore" });
  });
});
