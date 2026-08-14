import type { BotConfig } from "./config.ts";
import { authorizeMessage } from "./authorization.ts";
import { classifyMessage } from "./message.ts";
import { SerialTaskQueue } from "./serial-task-queue.ts";
import type { TaskWorkflowInput, TaskWorkflowResult } from "./task-workflow.ts";

export type IncomingBotMessage = {
  msgId: string;
  userId: string;
  chatId?: string;
  content: string;
  materializeAttachments(taskId: string): Promise<string[]>;
  cleanupAttachments(taskId: string): Promise<void>;
  reply(text: string): Promise<void>;
  notify(text: string): Promise<void>;
};

type Workflow = {
  run(input: TaskWorkflowInput): Promise<TaskWorkflowResult>;
};

type BotControllerDependencies = {
  loadConfig(): Promise<BotConfig>;
  createTaskId(messageId: string): string;
  workflow: Workflow;
};

export type HandleResult =
  | { kind: "identity" }
  | { kind: "projects" }
  | { kind: "project-required" }
  | { kind: "usage" }
  | { kind: "denied" }
  | { kind: "ignored" }
  | { kind: "duplicate" }
  | { kind: "queued"; taskId: string; completion: Promise<void> };

function successMessage(result: TaskWorkflowResult): string {
  const sizeMb = (result.artifact.sizeBytes / 1024 / 1024).toFixed(1);
  return `## 修复完成：${result.taskId}

- 项目：${result.projectId}
- 分支：${result.branchName}
- 提交：${result.commitHash}
- 安装包：${result.artifact.filename}（${sizeMb} MB）
- SHA-256：${result.artifact.sha256}

[下载安装包](${result.artifact.downloadUrl})

${result.codexSummary}`;
}

function failureMessage(taskId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `## 修复失败：${taskId}\n\n${message.slice(0, 2_000)}`;
}

export class BotController {
  readonly #dependencies: BotControllerDependencies;
  readonly #queue = new SerialTaskQueue();

  constructor(dependencies: BotControllerDependencies) {
    this.#dependencies = dependencies;
  }

  async handle(message: IncomingBotMessage): Promise<HandleResult> {
    const config = await this.#dependencies.loadConfig();
    const decision = authorizeMessage(config.permissionGroups, {
      command: classifyMessage(message.content),
      userId: message.userId,
      ...(message.chatId === undefined ? {} : { chatId: message.chatId }),
    });

    if (decision.kind === "identity") {
      await message.reply(
        `你的 userid：${decision.userId}\n当前 chatid：${decision.chatId ?? "单聊无 chatid"}`,
      );
      return { kind: "identity" };
    }
    if (decision.kind === "ignore") {
      return { kind: "ignored" };
    }
    if (decision.kind === "usage") {
      await message.reply("用法：`/fix <项目ID> <问题描述>`；发送 `/projects` 查看可用项目。");
      return { kind: "usage" };
    }
    if (decision.kind === "projects") {
      await message.reply(`当前群可操作项目：\n${decision.projectIds.map((id) => `- ${id}`).join("\n")}`);
      return { kind: "projects" };
    }
    if (decision.kind === "project-required") {
      await message.reply(
        `你在当前群有多个可操作项目，请明确指定：\n${decision.projectIds.map((id) => `- ${id}`).join("\n")}\n\n用法：\`/fix <项目ID> <问题描述>\``,
      );
      return { kind: "project-required" };
    }
    if (decision.kind === "denied") {
      if (decision.reason === "user") {
        await message.reply(`无权触发代码任务。你的 userid：${decision.userId}`);
      } else if (decision.reason === "project") {
        await message.reply(
          `你无权操作项目 ${decision.projectId}。当前可用项目：${decision.allowedProjectIds.join("、")}`,
        );
      } else {
        await message.reply(`当前群不在白名单中。chatid：${message.chatId ?? "无"}`);
      }
      return { kind: "denied" };
    }

    const taskId = this.#dependencies.createTaskId(message.msgId);
    const queued = this.#queue.enqueue(message.msgId, async () => {
      try {
        const imagePaths = await message.materializeAttachments(taskId);
        return await this.#dependencies.workflow.run({
          taskId,
          projectId: decision.projectId,
          prompt: decision.prompt,
          imagePaths,
          config,
          onProgress: (progress) => {
            void message.notify(`**${taskId}**：${progress}`).catch(() => undefined);
          },
        });
      } finally {
        await message.cleanupAttachments(taskId);
      }
    });
    if (!queued.accepted) {
      await message.reply("这条消息已经处理过，不会重复执行。");
      return { kind: "duplicate" };
    }

    await message.reply(
      `已创建任务 **${taskId}**，项目：**${decision.projectId}**，当前队列位置：${queued.position}`,
    );
    const completion = queued.completion.then(
      async (result) => message.notify(successMessage(result)),
      async (error: unknown) => message.notify(failureMessage(taskId, error)),
    );
    return { kind: "queued", taskId, completion };
  }
}
