import type { PermissionGroupConfig } from "./config.ts";
import type { BotCommand } from "./message.ts";

type AuthorizationInput = {
  command: BotCommand;
  userId: string;
  chatId?: string;
};

export type AuthorizationDecision =
  | { kind: "identity"; userId: string; chatId?: string }
  | { kind: "projects"; projectIds: string[] }
  | { kind: "project-required"; prompt: string; projectIds: string[] }
  | { kind: "usage" }
  | { kind: "ignore" }
  | { kind: "denied"; reason: "chat" }
  | { kind: "denied"; reason: "user"; userId: string }
  | { kind: "denied"; reason: "project"; projectId: string; allowedProjectIds: string[] }
  | { kind: "allowed"; projectId: string; prompt: string };

function uniqueSortedProjectIds(groups: readonly PermissionGroupConfig[]): string[] {
  return [...new Set(groups.flatMap((group) => group.allowedProjectIds))].sort();
}

export function authorizeMessage(
  permissionGroups: readonly PermissionGroupConfig[],
  input: AuthorizationInput,
): AuthorizationDecision {
  if (input.command.kind === "identity") {
    return {
      kind: "identity",
      userId: input.userId,
      ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
    };
  }
  if (input.command.kind === "ignore") {
    return { kind: "ignore" };
  }
  if (input.command.kind === "usage") {
    return { kind: "usage" };
  }

  const chatGroups = permissionGroups.filter(
    (group) => input.chatId !== undefined && group.allowedChatIds.includes(input.chatId),
  );
  if (chatGroups.length === 0) {
    return { kind: "denied", reason: "chat" };
  }
  const userGroups = chatGroups.filter((group) => group.allowedUserIds.includes(input.userId));
  if (userGroups.length === 0) {
    return { kind: "denied", reason: "user", userId: input.userId };
  }

  const allowedProjectIds = uniqueSortedProjectIds(userGroups);
  if (input.command.kind === "projects") {
    return { kind: "projects", projectIds: allowedProjectIds };
  }
  if (input.command.projectId !== undefined) {
    if (!allowedProjectIds.includes(input.command.projectId)) {
      return {
        kind: "denied",
        reason: "project",
        projectId: input.command.projectId,
        allowedProjectIds,
      };
    }
    return {
      kind: "allowed",
      projectId: input.command.projectId,
      prompt: input.command.prompt,
    };
  }
  if (allowedProjectIds.length > 1) {
    return {
      kind: "project-required",
      prompt: input.command.prompt,
      projectIds: allowedProjectIds,
    };
  }
  const [projectId] = allowedProjectIds;
  if (projectId === undefined) {
    return { kind: "denied", reason: "user", userId: input.userId };
  }
  return { kind: "allowed", projectId, prompt: input.command.prompt };
}
