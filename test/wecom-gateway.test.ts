import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createIncomingMixedMessage,
  createIncomingTextMessage,
  startWeComGateway,
  type EventedWeComClient,
  type MixedFrame,
  type TextFrame,
  type WeComClient,
} from "../src/wecom-gateway.ts";

function fakeClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client: WeComClient = {
    async replyStream(...args) {
      calls.push({ method: "replyStream", args });
    },
    async sendMessage(...args) {
      calls.push({ method: "sendMessage", args });
    },
    async replyTemplateCard(...args) {
      calls.push({ method: "replyTemplateCard", args });
    },
    async updateTemplateCard(...args) {
      calls.push({ method: "updateTemplateCard", args });
    },
    async downloadFile(...args) {
      calls.push({ method: "downloadFile", args });
      return { buffer: Buffer.from("image-data"), filename: "../screen shot.png" };
    },
  };
  return { client, calls };
}

describe("企微消息适配", () => {
  it("启动时注册消息监听并连接，停止时主动断开", async () => {
    const listeners = new Map<string, (payload: unknown) => Promise<void> | void>();
    let connected = false;
    let disconnected = false;
    let handledContent = "";
    const base = fakeClient().client;
    const client: EventedWeComClient = {
      ...base,
      on(event, listener) {
        listeners.set(event, listener);
        return this;
      },
      connect() {
        connected = true;
        return this;
      },
      disconnect() {
        disconnected = true;
      },
    };
    const gateway = startWeComGateway({
      client,
      runtimeDirectory: "/tmp/runtime",
      createStreamId: () => "stream-1",
      controller: {
        async handle(message) {
          handledContent = message.content;
          return { kind: "ignored" };
        },
        async handleProjectSelection() {
          return { kind: "expired" };
        },
      },
      logger: { error: () => undefined },
    });

    assert.equal(connected, true);
    const textListener = listeners.get("message.text");
    assert.ok(textListener);
    await textListener({
      headers: { req_id: "req-1" },
      body: {
        msgid: "msg-1",
        from: { userid: "owner" },
        chatid: "group-1",
        text: { content: "修复白屏" },
      },
    });
    assert.equal(handledContent, "修复白屏");

    gateway.stop();
    assert.equal(disconnected, true);
  });

  it("把文本帧映射为控制器消息并通过原请求回复", async () => {
    const { client, calls } = fakeClient();
    const frame: TextFrame = {
      headers: { req_id: "req-1" },
      body: {
        msgid: "msg-1",
        from: { userid: "zhangsan" },
        chatid: "group-1",
        text: { content: "修复白屏" },
      },
    };
    const incoming = createIncomingTextMessage(client, "/tmp/runtime", frame, () => "stream-1");

    assert.equal(incoming.msgId, "msg-1");
    assert.equal(incoming.userId, "zhangsan");
    assert.equal(incoming.chatId, "group-1");
    assert.equal(incoming.content, "修复白屏");
    await incoming.reply("已收到");
    await incoming.notify("处理中");

    assert.deepEqual(calls, [
      { method: "replyStream", args: [frame, "stream-1", "已收到", true] },
      {
        method: "sendMessage",
        args: ["group-1", { msgtype: "markdown", markdown: { content: "处理中" } }],
      },
    ]);
  });

  it("单聊任务进度主动发送给发消息人的 userid", async () => {
    const { client, calls } = fakeClient();
    const frame: TextFrame = {
      headers: { req_id: "req-direct" },
      body: {
        msgid: "msg-direct",
        from: { userid: "zhangsan" },
        text: { content: "启动后白屏" },
      },
    };

    const incoming = createIncomingTextMessage(client, "/tmp/runtime", frame, () => "stream");
    await incoming.notify("处理中");

    assert.deepEqual(calls, [{
      method: "sendMessage",
      args: ["zhangsan", { msgtype: "markdown", markdown: { content: "处理中" } }],
    }]);
  });

  it("多项目消息回复带展示名称的项目选择卡片", async () => {
    const { client, calls } = fakeClient();
    const frame: TextFrame = {
      headers: { req_id: "req-card" },
      body: {
        msgid: "msg-card",
        from: { userid: "owner" },
        chatid: "group-1",
        text: { content: "修复权限页面" },
      },
    };
    const incoming = createIncomingTextMessage(client, "/tmp/runtime", frame, () => "stream");

    await incoming.replyProjectSelection("select_task-001", [
      { projectId: "admin-panel", displayName: "管理后台" },
      { projectId: "desktop-client", displayName: "桌面客户端" },
    ]);

    assert.deepEqual(calls, [{
      method: "replyTemplateCard",
      args: [frame, {
        card_type: "button_interaction",
        main_title: { title: "请选择要修改的项目" },
        button_list: [
          { text: "管理后台", key: "admin-panel", style: 1 },
          { text: "桌面客户端", key: "desktop-client", style: 1 },
        ],
        task_id: "select_task-001",
      }],
    }]);
  });

  it("接收企微真实的嵌套项目卡片事件并继续处理原消息", async () => {
    const listeners = new Map<string, (payload: unknown) => Promise<void> | void>();
    const { client: base, calls } = fakeClient();
    const client: EventedWeComClient = {
      ...base,
      on(event, listener) { listeners.set(event, listener); return this; },
      connect() { return this; },
      disconnect() {},
    };
    let received: unknown;
    startWeComGateway({
      client,
      runtimeDirectory: "/tmp/runtime",
      createStreamId: () => "stream",
      controller: {
        async handle() { return { kind: "ignored" }; },
        async handleProjectSelection(selection) {
          received = {
            selectionId: selection.selectionId,
            projectId: selection.projectId,
            userId: selection.userId,
            chatId: selection.chatId,
          };
          await selection.updateCard("已选择：管理后台，任务已创建。");
          return { kind: "expired" };
        },
      },
      logger: { error: () => undefined },
    });
    const frame = {
      headers: { req_id: "req-card-event" },
      body: {
        msgid: "event-1",
        from: { userid: "owner" },
        chatid: "group-1",
        event: {
          eventtype: "template_card_event",
          template_card_event: {
            event_key: "admin-panel",
            task_id: "select_task-001",
          },
        },
      },
    };

    const listener = listeners.get("event.template_card_event");
    assert.ok(listener);
    await listener(frame);

    assert.deepEqual(received, {
      selectionId: "select_task-001",
      projectId: "admin-panel",
      userId: "owner",
      chatId: "group-1",
    });
    assert.deepEqual(calls, [{
      method: "updateTemplateCard",
      args: [frame, {
        card_type: "text_notice",
        main_title: { title: "已选择：管理后台，任务已创建。" },
        task_id: "select_task-001",
      }, ["owner"]],
    }]);
  });

  it("授权后才下载图文消息中的图片，并清理任务附件", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "wecom-runtime-"));
    const { client, calls } = fakeClient();
    const frame: MixedFrame = {
      headers: { req_id: "req-2" },
      body: {
        msgid: "msg-2",
        from: { userid: "zhangsan" },
        chatid: "group-1",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "点击后崩溃" } },
            { msgtype: "image", image: { url: "https://image", aeskey: "aes-key" } },
          ],
        },
      },
    };

    try {
      const incoming = createIncomingMixedMessage(client, runtime, frame, () => "stream-2");
      assert.equal(incoming.content, "点击后崩溃");
      assert.equal(calls.length, 0);

      const attachments = await incoming.materializeAttachments("task-002");
      assert.equal(calls[0]?.method, "downloadFile");
      assert.deepEqual(calls[0]?.args, ["https://image", "aes-key"]);
      assert.equal(await readFile(attachments.imagePaths[0] ?? "", "utf8"), "image-data");
      assert.equal(attachments.imagePaths[0]?.endsWith("screen_shot.png"), true);
      assert.deepEqual(attachments.filePaths, []);

      await incoming.cleanupAttachments("task-002");
      await assert.rejects(access(join(runtime, "incoming", "task-002")));
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  });

  it("把引用文本和语音转写追加为明确标记的问题上下文", () => {
    const { client } = fakeClient();
    const textFrame: TextFrame = {
      headers: { req_id: "req-quote-text" },
      body: {
        msgid: "msg-quote-text",
        from: { userid: "zhangsan" },
        chatid: "group-1",
        text: { content: "@代码机器人 /fix desktop-client 看看这个报错" },
        quote: { msgtype: "text", text: { content: "TypeError: window is undefined" } },
      },
    };
    const voiceFrame: TextFrame = {
      headers: { req_id: "req-quote-voice" },
      body: {
        msgid: "msg-quote-voice",
        from: { userid: "zhangsan" },
        chatid: "group-1",
        text: { content: "@代码机器人 /fix desktop-client 修复这个问题" },
        quote: { msgtype: "voice", voice: { content: "打开软件后一直白屏" } },
      },
    };

    const quotedText = createIncomingTextMessage(client, "/tmp/runtime", textFrame, () => "stream");
    const quotedVoice = createIncomingTextMessage(client, "/tmp/runtime", voiceFrame, () => "stream");

    assert.match(quotedText.content, /被引用消息：文本/);
    assert.match(quotedText.content, /TypeError: window is undefined/);
    assert.match(quotedVoice.content, /被引用消息：语音转写/);
    assert.match(quotedVoice.content, /打开软件后一直白屏/);
  });

  it("引用图文中的文字进入上下文，图片在授权后才下载", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "wecom-quote-mixed-"));
    const { client, calls } = fakeClient();
    const frame: TextFrame = {
      headers: { req_id: "req-quote-mixed" },
      body: {
        msgid: "msg-quote-mixed",
        from: { userid: "zhangsan" },
        chatid: "group-1",
        text: { content: "@代码机器人 /fix desktop-client 根据引用修复" },
        quote: {
          msgtype: "mixed",
          mixed: {
            msg_item: [
              { msgtype: "text", text: { content: "点击保存后页面卡死" } },
              { msgtype: "image", image: { url: "https://quote-image", aeskey: "quote-aes" } },
            ],
          },
        },
      },
    };

    try {
      const incoming = createIncomingTextMessage(client, runtime, frame, () => "stream");
      assert.match(incoming.content, /被引用消息：图文/);
      assert.match(incoming.content, /点击保存后页面卡死/);
      assert.equal(calls.length, 0);

      const attachments = await incoming.materializeAttachments("task-quote-mixed");
      assert.deepEqual(calls[0]?.args, ["https://quote-image", "quote-aes"]);
      assert.equal(attachments.imagePaths.length, 1);
      assert.deepEqual(attachments.filePaths, []);
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  });

  it("引用文件在授权后下载为普通文件附件，不会作为图片参数传给 Codex", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "wecom-quote-file-"));
    const { client, calls } = fakeClient();
    const frame: TextFrame = {
      headers: { req_id: "req-quote-file" },
      body: {
        msgid: "msg-quote-file",
        from: { userid: "zhangsan" },
        chatid: "group-1",
        text: { content: "@代码机器人 /fix desktop-client 分析引用日志" },
        quote: { msgtype: "file", file: { url: "https://quote-file", aeskey: "file-aes" } },
      },
    };

    try {
      const incoming = createIncomingTextMessage(client, runtime, frame, () => "stream");
      assert.match(incoming.content, /被引用消息：文件/);
      assert.equal(calls.length, 0);

      const attachments = await incoming.materializeAttachments("task-quote-file");
      assert.deepEqual(calls[0]?.args, ["https://quote-file", "file-aes"]);
      assert.deepEqual(attachments.imagePaths, []);
      assert.equal(await readFile(attachments.filePaths[0] ?? "", "utf8"), "image-data");
      assert.equal(attachments.filePaths[0]?.endsWith("screen_shot.png"), true);
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  });
});
