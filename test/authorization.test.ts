import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorizeMessage, authorizeProjectSelection } from "../src/authorization.ts";
import { classifyMessage } from "../src/message.ts";

const permissionGroups = [
  {
    name: "桌面端支持组",
    allowedUserIds: ["owner", "tester"],
    allowedChatIds: ["weekend-feedback"],
    allowDirectMessages: false,
    allowedProjectIds: ["desktop-client"],
  },
  {
    name: "管理员组",
    allowedUserIds: ["owner"],
    allowedChatIds: ["weekend-feedback"],
    allowDirectMessages: true,
    allowedProjectIds: ["desktop-client", "admin-panel"],
  },
];

describe("自然消息与项目权限组", () => {
  it("移除机器人 @ 前缀后把普通语言完整作为问题描述", () => {
    assert.deepEqual(classifyMessage("@代码机器人 修复启动白屏"), {
      kind: "request",
      prompt: "修复启动白屏",
    });
  });

  it("不再把斜杠内容解释为机器人命令", () => {
    assert.deepEqual(classifyMessage("/fix desktop-client 修复启动白屏"), {
      kind: "request",
      prompt: "/fix desktop-client 修复启动白屏",
    });
    assert.deepEqual(classifyMessage("/whoami"), {
      kind: "request",
      prompt: "/whoami",
    });
  });

  it("群聊按 userid + chatid 得到可操作项目", () => {
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

  it("多项目用户发送自然消息时要求显示项目选择卡片", () => {
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

  it("单聊不需要 chatid，但只命中显式允许单聊的权限组", () => {
    const owner = authorizeMessage(permissionGroups, {
      command: classifyMessage("修复启动白屏"),
      userId: "owner",
    });
    const tester = authorizeMessage(permissionGroups, {
      command: classifyMessage("修复启动白屏"),
      userId: "tester",
    });

    assert.deepEqual(owner, {
      kind: "project-required",
      prompt: "修复启动白屏",
      projectIds: ["admin-panel", "desktop-client"],
    });
    assert.deepEqual(tester, {
      kind: "denied",
      reason: "user",
      userId: "tester",
    });
  });

  it("拒绝没有权限组覆盖的群和群内未授权用户", () => {
    assert.deepEqual(
      authorizeMessage(permissionGroups, {
        command: classifyMessage("修复启动白屏"),
        userId: "owner",
        chatId: "another-group",
      }),
      { kind: "denied", reason: "chat" },
    );
    assert.deepEqual(
      authorizeMessage(permissionGroups, {
        command: classifyMessage("修复启动白屏"),
        userId: "visitor",
        chatId: "weekend-feedback",
      }),
      { kind: "denied", reason: "user", userId: "visitor" },
    );
  });

  it("点击项目卡片时重新校验用户、会话和项目权限", () => {
    assert.deepEqual(
      authorizeProjectSelection(permissionGroups, {
        userId: "owner",
        chatId: "weekend-feedback",
        projectId: "admin-panel",
      }),
      { kind: "allowed", projectId: "admin-panel" },
    );
    assert.deepEqual(
      authorizeProjectSelection(permissionGroups, {
        userId: "tester",
        projectId: "desktop-client",
      }),
      { kind: "denied", reason: "user", userId: "tester" },
    );
    assert.deepEqual(
      authorizeProjectSelection(permissionGroups, {
        userId: "owner",
        projectId: "not-allowed",
      }),
      {
        kind: "denied",
        reason: "project",
        projectId: "not-allowed",
        allowedProjectIds: ["admin-panel", "desktop-client"],
      },
    );
  });

  it("忽略空消息", () => {
    assert.deepEqual(classifyMessage("   "), { kind: "ignore" });
  });
});
