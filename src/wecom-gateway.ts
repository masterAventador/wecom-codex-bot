import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { QuoteContent } from "@wecom/aibot-node-sdk";

import type { IncomingBotMessage } from "./bot-controller.ts";
import type { HandleResult } from "./bot-controller.ts";

type FrameHeaders = { req_id: string; [key: string]: unknown };
type BaseBody = {
  msgid: string;
  from: { userid: string };
  chatid?: string;
  quote?: QuoteContent;
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

type DownloadReference = { url: string; aesKey?: string };

type QuoteDetails = {
  context: string;
  images: DownloadReference[];
  files: DownloadReference[];
};

function reference(value: { url: string; aeskey?: string }): DownloadReference {
  return {
    url: value.url,
    ...(value.aeskey === undefined ? {} : { aesKey: value.aeskey }),
  };
}

function extractQuote(quote: QuoteContent | undefined): QuoteDetails {
  if (quote === undefined) {
    return { context: "", images: [], files: [] };
  }
  if (quote.msgtype === "text") {
    return {
      context: `[被引用消息：文本]\n${quote.text?.content ?? "[内容不可用]"}`,
      images: [],
      files: [],
    };
  }
  if (quote.msgtype === "voice") {
    return {
      context: `[被引用消息：语音转写]\n${quote.voice?.content ?? "[转写内容不可用]"}`,
      images: [],
      files: [],
    };
  }
  if (quote.msgtype === "image") {
    const images = quote.image?.url ? [reference(quote.image)] : [];
    return {
      context: "[被引用消息：图片]\n图片已作为不可信附件提供。",
      images,
      files: [],
    };
  }
  if (quote.msgtype === "file") {
    const files = quote.file?.url ? [reference(quote.file)] : [];
    return {
      context: "[被引用消息：文件]\n文件将在授权后作为不可信附件提供。",
      images: [],
      files,
    };
  }

  const items = quote.mixed?.msg_item ?? [];
  const text = items
    .filter((item) => item.msgtype === "text")
    .map((item) => item.text?.content ?? "")
    .filter((value) => value.length > 0)
    .join("\n");
  const images = items
    .filter((item) => item.msgtype === "image" && item.image?.url)
    .map((item) => reference(item.image!));
  return {
    context: `[被引用消息：图文]\n${text || "[仅包含图片]"}`,
    images,
    files: [],
  };
}

function attachmentName(filename: string | undefined, fallback: string): string {
  const candidate = filename === undefined || filename.trim().length === 0 ? fallback : filename;
  const safeName = basename(candidate).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return safeName === "." || safeName === ".." || safeName.length === 0 ? fallback : safeName;
}

function commonMessage(
  client: WeComClient,
  runtimeDirectory: string,
  frame: TextFrame | MixedFrame,
  content: string,
  images: readonly DownloadReference[],
  files: readonly DownloadReference[],
  createStreamId: () => string,
): IncomingBotMessage {
  const body = frame.body;
  return {
    msgId: body.msgid,
    userId: body.from.userid,
    ...(body.chatid === undefined ? {} : { chatId: body.chatid }),
    content,
    async materializeAttachments(taskId) {
      if (images.length === 0 && files.length === 0) {
        return { imagePaths: [], filePaths: [] };
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) {
        throw new Error("任务编号含有不安全字符");
      }
      const taskDirectory = join(runtimeDirectory, "incoming", taskId);
      await mkdir(taskDirectory, { recursive: true });
      const imagePaths: string[] = [];
      for (const [index, image] of images.entries()) {
        const downloaded = await client.downloadFile(image.url, image.aesKey);
        const safeName = attachmentName(downloaded.filename, `image-${index + 1}.png`);
        const outputPath = join(taskDirectory, `image-${index + 1}-${safeName}`);
        await writeFile(outputPath, downloaded.buffer);
        imagePaths.push(outputPath);
      }
      const filePaths: string[] = [];
      for (const [index, file] of files.entries()) {
        const downloaded = await client.downloadFile(file.url, file.aesKey);
        const safeName = attachmentName(downloaded.filename, `file-${index + 1}.bin`);
        const outputPath = join(taskDirectory, `file-${index + 1}-${safeName}`);
        await writeFile(outputPath, downloaded.buffer);
        filePaths.push(outputPath);
      }
      return { imagePaths, filePaths };
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
  const quote = extractQuote(frame.body.quote);
  const content = quote.context.length === 0
    ? frame.body.text.content
    : `${frame.body.text.content}\n\n${quote.context}`;
  return commonMessage(
    client,
    runtimeDirectory,
    frame,
    content,
    quote.images,
    quote.files,
    createStreamId,
  );
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
  const images: DownloadReference[] = [];
  for (const item of frame.body.mixed.msg_item) {
    if (item.msgtype === "image" && item.image !== undefined && item.image.url.length > 0) {
      images.push({
        url: item.image.url,
        ...(item.image.aeskey === undefined ? {} : { aesKey: item.image.aeskey }),
      });
    }
  }
  const quote = extractQuote(frame.body.quote);
  const content = quote.context.length === 0 ? text : `${text}\n\n${quote.context}`;
  return commonMessage(
    client,
    runtimeDirectory,
    frame,
    content,
    [...images, ...quote.images],
    quote.files,
    createStreamId,
  );
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
