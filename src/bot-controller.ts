import type { BotConfig } from "./config.ts";
import { authorizeMessage, authorizeProjectSelection } from "./authorization.ts";
import { classifyMessage } from "./message.ts";
import { ClarificationNeededError } from "./issue-triage.ts";
import { SerialTaskQueue } from "./serial-task-queue.ts";
import { createTaskDisplayName } from "./task-id.ts";
import type { TaskWorkflowInput, TaskWorkflowResult } from "./task-workflow.ts";

export type ProjectChoice = {
  projectId: string;
  displayName: string;
};

export type IncomingBotMessage = {
  msgId: string;
  userId: string;
  chatId?: string;
  content: string;
  materializeAttachments(taskId: string): Promise<{
    imagePaths: string[];
    filePaths: string[];
  }>;
  cleanupAttachments(taskId: string): Promise<void>;
  reply(text: string): Promise<void>;
  replyProjectSelection(selectionId: string, projects: readonly ProjectChoice[]): Promise<void>;
  notify(text: string): Promise<void>;
};

export type IncomingProjectSelection = {
  selectionId: string;
  projectId: string;
  userId: string;
  chatId?: string;
  updateCard(text: string): Promise<void>;
};

type Workflow = {
  run(input: TaskWorkflowInput): Promise<TaskWorkflowResult>;
};

type BotControllerDependencies = {
  loadConfig(): Promise<BotConfig>;
  createTaskId(messageId: string): string;
  summarizeTaskTitle?(prompt: string): Promise<string>;
  verboseProgress?: boolean;
  now?(): number;
  workflow: Workflow;
};

export type HandleResult =
  | { kind: "project-selection"; selectionId: string }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "ignored" }
  | { kind: "duplicate" }
  | { kind: "queued"; taskId: string; completion: Promise<void> };

type PendingProjectSelection = {
  taskId: string;
  prompt: string;
  projectIds: readonly string[];
  createdAt: number;
  message: IncomingBotMessage;
};

type QueueTaskInput = {
  taskId: string;
  projectId: string;
  prompt: string;
  projectDisplayName: string;
  initiatorDisplayName?: string;
  config: BotConfig;
  message: IncomingBotMessage;
  acknowledge(position: number): Promise<void>;
};

const MAX_PROJECT_CARD_CHOICES = 6;
const PROJECT_SELECTION_TTL_MS = 5 * 60 * 1_000;

function visibleCodexSummary(summary: string): string {
  return summary
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:[-*•⦁]\s*)?(?:原因|根因)\s*[:：]/u.test(line))
    .join("\n")
    .trim();
}

function successMessage(
  result: TaskWorkflowResult,
  projectDisplayName: string,
  taskDisplayName: string,
): string {
  if (result.deliveryMode === "answer") {
    return `## 项目答疑：${taskDisplayName}\n\n${result.answer}`;
  }
  const summary = visibleCodexSummary(result.codexSummary);
  const gitResult = result.mergedToBaseBranch === undefined
    ? `- 分支：${result.branchName}\n- 提交：${result.commitHash}`
    : `- 已合并：${result.mergedToBaseBranch}\n- 提交：${result.commitHash}\n- 清理：任务分支和 worktree 已删除`;
  const deployResult = result.deployed === true
    ? "\n- 部署：已按项目预设命令完成"
    : "";
  if (result.deliveryMode === "code") {
    return `## 代码修改完成：${taskDisplayName}

- 项目：${projectDisplayName}
${gitResult}
- 交付状态：${result.deployed === true
    ? "代码已合并到本地基础分支，并已完成明确请求的部署"
    : result.mergedToBaseBranch === undefined
      ? "代码已保存在本地任务分支，未自动部署"
      : "代码已合并到本地基础分支，未自动部署"}${deployResult}

${summary}`;
  }
  const sizeMb = (result.artifact.sizeBytes / 1024 / 1024).toFixed(1);
  return `## 修复完成：${taskDisplayName}

- 项目：${projectDisplayName}
${gitResult}
- 安装包：${result.artifact.filename}（${sizeMb} MB）
- SHA-256：${result.artifact.sha256}
${deployResult}

[下载安装包](${result.artifact.downloadUrl})

${summary}`;
}

function failureMessage(taskDisplayName: string, error: unknown, isGroup: boolean): string {
  if (error instanceof ClarificationNeededError) {
    const followUp = isGroup
      ? "群聊中请引用本消息并再次 @我。"
      : "请直接回复补充信息。";
    return `## 需要补充信息：${taskDisplayName}\n\n${error.message}\n\n${followUp}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `## 修复失败：${taskDisplayName}\n\n${message.slice(0, 2_000)}`;
}

function mentionInitiator(
  message: IncomingBotMessage,
  displayName: string | undefined,
  text: string,
): string {
  if (message.chatId === undefined || displayName === undefined) {
    return text;
  }
  const safeName = displayName.replace(/[@<>\r\n*_`#]/gu, "").trim();
  return safeName.length === 0 ? text : `@${safeName}\n\n${text}`;
}

export class BotController {
  readonly #dependencies: BotControllerDependencies;
  readonly #queue = new SerialTaskQueue();
  readonly #pendingSelections = new Map<string, PendingProjectSelection>();

  constructor(dependencies: BotControllerDependencies) {
    this.#dependencies = dependencies;
  }

  async handle(message: IncomingBotMessage): Promise<HandleResult> {
    this.#deleteExpiredSelections();
    const config = await this.#dependencies.loadConfig();
    const decision = authorizeMessage(config.permissionGroups, {
      command: classifyMessage(message.content),
      userId: message.userId,
      ...(message.chatId === undefined ? {} : { chatId: message.chatId }),
    });

    if (decision.kind === "ignore") {
      return { kind: "ignored" };
    }
    if (decision.kind === "denied") {
      if (decision.reason === "project") {
        await message.reply(
          `你无权操作项目 ${decision.projectId}。当前可用项目：${decision.allowedProjectIds.join("、")}`,
        );
      } else if (message.chatId !== undefined) {
        await message.reply(
          `当前群或用户不在白名单中。\n\nuserid：${message.userId}\nchatid：${message.chatId}`,
        );
      } else {
        await message.reply(`当前私聊用户不在白名单中。userid：${message.userId}`);
      }
      return { kind: "denied" };
    }

    const taskId = this.#dependencies.createTaskId(message.msgId);
    if (decision.kind === "project-required") {
      if (decision.projectIds.length > MAX_PROJECT_CARD_CHOICES) {
        await message.reply(
          `当前权限匹配了 ${decision.projectIds.length} 个项目，企微选择卡片最多支持 6 个项目。请调整权限组后重试。`,
        );
        return { kind: "denied" };
      }
      const selectionId = `select_${taskId}`;
      const existing = this.#pendingSelections.get(selectionId);
      if (existing !== undefined && !this.#selectionExpired(existing)) {
        await message.reply("这条消息已经处理过，不会重复创建项目选择卡片。");
        return { kind: "duplicate" };
      }
      this.#pendingSelections.delete(selectionId);
      const projects = decision.projectIds.map((projectId) => ({
        projectId,
        displayName: config.projects[projectId]!.displayName,
      }));
      this.#pendingSelections.set(selectionId, {
        taskId,
        prompt: decision.prompt,
        projectIds: decision.projectIds,
        createdAt: this.#now(),
        message,
      });
      try {
        await message.replyProjectSelection(selectionId, projects);
      } catch (error) {
        this.#pendingSelections.delete(selectionId);
        throw error;
      }
      return { kind: "project-selection", selectionId };
    }

    const project = config.projects[decision.projectId]!;
    const initiatorDisplayName = config.userDisplayNames?.[message.userId];
    return this.#queueTask({
      taskId,
      projectId: decision.projectId,
      prompt: decision.prompt,
      projectDisplayName: project.displayName,
      ...(initiatorDisplayName === undefined ? {} : { initiatorDisplayName }),
      config,
      message,
      acknowledge: async (position) => message.reply(
        `已收到，项目：**${project.displayName}**，当前队列位置：${position}`,
      ),
    });
  }

  async handleProjectSelection(selection: IncomingProjectSelection): Promise<HandleResult> {
    this.#deleteExpiredSelections();
    const pending = this.#pendingSelections.get(selection.selectionId);
    if (pending === undefined) {
      await selection.updateCard("选择已失效，请重新描述问题。");
      return { kind: "expired" };
    }
    if (
      pending.message.userId !== selection.userId
      || pending.message.chatId !== selection.chatId
    ) {
      await selection.updateCard("无权操作：这张项目选择卡片不属于你或当前会话。");
      return { kind: "denied" };
    }

    const config = await this.#dependencies.loadConfig();
    const decision = authorizeProjectSelection(config.permissionGroups, {
      userId: selection.userId,
      projectId: selection.projectId,
      ...(selection.chatId === undefined ? {} : { chatId: selection.chatId }),
    });
    const project = config.projects[selection.projectId];
    if (
      decision.kind === "denied"
      || !pending.projectIds.includes(selection.projectId)
      || project === undefined
    ) {
      await selection.updateCard("无权操作这个项目，请重新描述问题后再选择。");
      return { kind: "denied" };
    }

    this.#pendingSelections.delete(selection.selectionId);
    const initiatorDisplayName = config.userDisplayNames?.[pending.message.userId];
    return this.#queueTask({
      taskId: pending.taskId,
      projectId: selection.projectId,
      prompt: pending.prompt,
      projectDisplayName: project.displayName,
      ...(initiatorDisplayName === undefined ? {} : { initiatorDisplayName }),
      config,
      message: pending.message,
      acknowledge: async () => {
        await Promise.all([
          selection.updateCard(
            `已选择：${project.displayName}，消息已进入处理队列。`,
          ).catch(() => undefined),
          pending.message.notify(`已选择项目：**${project.displayName}**，正在处理。`),
        ]);
      },
    });
  }

  async #queueTask(input: QueueTaskInput): Promise<HandleResult> {
    let taskDisplayNamePromise: Promise<string> | undefined;
    const getTaskDisplayName = () => {
      taskDisplayNamePromise ??= this.#createTaskDisplayName(input.prompt);
      return taskDisplayNamePromise;
    };
    const queued = this.#queue.enqueue(input.message.msgId, async () => {
      try {
        const taskDisplayName = await getTaskDisplayName();
        const attachments = await input.message.materializeAttachments(input.taskId);
        return await this.#dependencies.workflow.run({
          taskId: input.taskId,
          projectId: input.projectId,
          prompt: input.prompt,
          imagePaths: attachments.imagePaths,
          filePaths: attachments.filePaths,
          config: input.config,
          onProgress: this.#dependencies.verboseProgress === true
            ? (progress) => {
              void input.message.notify(`**${taskDisplayName}**：${progress}`).catch(() => undefined);
            }
            : () => undefined,
        });
      } finally {
        await input.message.cleanupAttachments(input.taskId);
      }
    });
    if (!queued.accepted) {
      await input.message.reply("这条消息已经处理过，不会重复执行。");
      return { kind: "duplicate" };
    }

    const completion = queued.completion.then(
      async (result) => input.message.notify(mentionInitiator(
        input.message,
        input.initiatorDisplayName,
        successMessage(result, input.projectDisplayName, await getTaskDisplayName()),
      )),
      async (error: unknown) => input.message.notify(mentionInitiator(
        input.message,
        input.initiatorDisplayName,
        failureMessage(await getTaskDisplayName(), error, input.message.chatId !== undefined),
      )),
    );
    try {
      await input.acknowledge(queued.position);
    } catch (error) {
      void completion.catch(() => undefined);
      throw error;
    }
    return { kind: "queued", taskId: input.taskId, completion };
  }

  #now(): number {
    return this.#dependencies.now?.() ?? Date.now();
  }

  async #createTaskDisplayName(prompt: string): Promise<string> {
    let title = prompt;
    try {
      title = await this.#dependencies.summarizeTaskTitle?.(prompt) ?? prompt;
    } catch {
      title = prompt;
    }
    return createTaskDisplayName(title, new Date(this.#now()));
  }

  #selectionExpired(selection: PendingProjectSelection): boolean {
    return this.#now() - selection.createdAt >= PROJECT_SELECTION_TTL_MS;
  }

  #deleteExpiredSelections(): void {
    for (const [selectionId, selection] of this.#pendingSelections) {
      if (this.#selectionExpired(selection)) {
        this.#pendingSelections.delete(selectionId);
      }
    }
  }
}
