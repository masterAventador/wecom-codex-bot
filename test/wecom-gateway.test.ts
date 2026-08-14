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

      const imagePaths = await incoming.materializeAttachments("task-002");
      assert.equal(calls[0]?.method, "downloadFile");
      assert.deepEqual(calls[0]?.args, ["https://image", "aes-key"]);
      assert.equal(await readFile(imagePaths[0] ?? "", "utf8"), "image-data");
      assert.equal(imagePaths[0]?.endsWith("screen shot.png"), true);

      await incoming.cleanupAttachments("task-002");
      await assert.rejects(access(join(runtime, "incoming", "task-002")));
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  });
});
