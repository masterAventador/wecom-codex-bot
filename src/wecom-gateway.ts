import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { IncomingBotMessage } from "./bot-controller.ts";
import type { HandleResult } from "./bot-controller.ts";

type FrameHeaders = { req_id: string; [key: string]: unknown };
type BaseBody = {
  msgid: string;
  from: { userid: string };
  chatid?: string;
};
export type TextFrame = {
  headers: FrameHeaders;
  body: BaseBody & { text: { content: string } };
};
type MixedItem =
  | { msgtype: "text"; text?: { content: string } }
  | { msgtype: "image"; image?: { url: string; aeskey?: string } };
export type MixedFrame = {
  headers: FrameHeaders;
  body: BaseBody & { mixed: { msg_item: MixedItem[] } };
};

export interface WeComClient {
  replyStream(
    frame: unknown,
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<unknown>;
  sendMessage(chatId: string, body: unknown): Promise<unknown>;
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

type WeComEvent = "message.text" | "message.mixed" | "error";

export interface EventedWeComClient extends WeComClient {
  on(event: WeComEvent, listener: (payload: unknown) => Promise<void> | void): this;
  connect(): this;
  disconnect(): void;
}

type MessageController = {
  handle(message: IncomingBotMessage): Promise<HandleResult>;
};

type GatewayLogger = {
  error(...values: unknown[]): void;
};

type ImageReference = { url: string; aesKey?: string };

function commonMessage(
  client: WeComClient,
  runtimeDirectory: string,
  frame: TextFrame | MixedFrame,
  content: string,
  images: readonly ImageReference[],
  createStreamId: () => string,
): IncomingBotMessage {
  const body = frame.body;
  return {
    msgId: body.msgid,
    userId: body.from.userid,
    ...(body.chatid === undefined ? {} : { chatId: body.chatid }),
    content,
    async materializeAttachments(taskId) {
      if (images.length === 0) {
        return [];
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) {
        throw new Error("任务编号含有不安全字符");
      }
      const taskDirectory = join(runtimeDirectory, "incoming", taskId);
      await mkdir(taskDirectory, { recursive: true });
      const paths: string[] = [];
      for (const [index, image] of images.entries()) {
        const downloaded = await client.downloadFile(image.url, image.aesKey);
        const safeName = basename(downloaded.filename ?? `image-${index + 1}.png`);
        const outputPath = join(taskDirectory, `${index + 1}-${safeName}`);
        await writeFile(outputPath, downloaded.buffer);
        paths.push(outputPath);
      }
      return paths;
    },
    async cleanupAttachments(taskId) {
      if (/^[a-zA-Z0-9._-]+$/.test(taskId)) {
        await rm(join(runtimeDirectory, "incoming", taskId), { recursive: true, force: true });
      }
    },
    async reply(text) {
      await client.replyStream(frame, createStreamId(), text, true);
    },
    async notify(text) {
      if (body.chatid === undefined) {
        throw new Error("单聊消息没有 chatid，无法主动推送任务进度");
      }
      await client.sendMessage(body.chatid, {
        msgtype: "markdown",
        markdown: { content: text },
      });
    },
  };
}

export function createIncomingTextMessage(
  client: WeComClient,
  runtimeDirectory: string,
  frame: TextFrame,
  createStreamId: () => string,
): IncomingBotMessage {
  return commonMessage(client, runtimeDirectory, frame, frame.body.text.content, [], createStreamId);
}

export function createIncomingMixedMessage(
  client: WeComClient,
  runtimeDirectory: string,
  frame: MixedFrame,
  createStreamId: () => string,
): IncomingBotMessage {
  const text = frame.body.mixed.msg_item
    .filter((item) => item.msgtype === "text")
    .map((item) => item.text?.content ?? "")
    .filter((value) => value.length > 0)
    .join("\n");
  const images: ImageReference[] = [];
  for (const item of frame.body.mixed.msg_item) {
    if (item.msgtype === "image" && item.image !== undefined && item.image.url.length > 0) {
      images.push({
        url: item.image.url,
        ...(item.image.aeskey === undefined ? {} : { aesKey: item.image.aeskey }),
      });
    }
  }
  return commonMessage(client, runtimeDirectory, frame, text, images, createStreamId);
}

type StartWeComGatewayOptions = {
  client: EventedWeComClient;
  controller: MessageController;
  runtimeDirectory: string;
  createStreamId(): string;
  logger: GatewayLogger;
};

export function startWeComGateway(options: StartWeComGatewayOptions): { stop(): void } {
  options.client.on("message.text", async (payload) => {
    try {
      await options.controller.handle(
        createIncomingTextMessage(
          options.client,
          options.runtimeDirectory,
          payload as TextFrame,
          options.createStreamId,
        ),
      );
    } catch (error) {
      options.logger.error(error, "处理企微文本消息失败");
    }
  });
  options.client.on("message.mixed", async (payload) => {
    try {
      await options.controller.handle(
        createIncomingMixedMessage(
          options.client,
          options.runtimeDirectory,
          payload as MixedFrame,
          options.createStreamId,
        ),
      );
    } catch (error) {
      options.logger.error(error, "处理企微图文消息失败");
    }
  });
  options.client.on("error", (error) => {
    options.logger.error(error, "企微 WebSocket 错误");
  });
  options.client.connect();

  return {
    stop() {
      options.client.disconnect();
    },
  };
}
