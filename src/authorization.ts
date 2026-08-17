import type { PermissionGroupConfig } from "./config.ts";
import type { BotCommand } from "./message.ts";

type ConversationInput = {
  userId: string;
  chatId?: string;
};

type AuthorizationInput = ConversationInput & {
  command: BotCommand;
};

type ProjectSelectionInput = ConversationInput & {
  projectId: string;
};

type DeniedDecision =
  | { kind: "denied"; reason: "chat" }
  | { kind: "denied"; reason: "user"; userId: string }
  | { kind: "denied"; reason: "project"; projectId: string; allowedProjectIds: string[] };

export type AuthorizationDecision =
  | { kind: "project-required"; prompt: string; projectIds: string[] }
  | { kind: "ignore" }
  | DeniedDecision
  | { kind: "allowed"; projectId: string; prompt: string };

export type ProjectSelectionDecision =
  | DeniedDecision
  | { kind: "allowed"; projectId: string };

function uniqueSortedProjectIds(groups: readonly PermissionGroupConfig[]): string[] {
  return [...new Set(groups.flatMap((group) => group.allowedProjectIds))].sort();
}

function conversationAccess(
  permissionGroups: readonly PermissionGroupConfig[],
  input: ConversationInput,
): DeniedDecision | { kind: "allowed"; projectIds: string[] } {
  const conversationGroups = input.chatId === undefined
    ? permissionGroups.filter((group) => group.allowDirectMessages)
    : permissionGroups.filter((group) => group.allowedChatIds.includes(input.chatId!));
  if (conversationGroups.length === 0 && input.chatId !== undefined) {
    return { kind: "denied", reason: "chat" };
  }
  const userGroups = conversationGroups.filter((group) => group.allowedUserIds.includes(input.userId));
  if (userGroups.length === 0) {
    return { kind: "denied", reason: "user", userId: input.userId };
  }
  return { kind: "allowed", projectIds: uniqueSortedProjectIds(userGroups) };
}

export function authorizeMessage(
  permissionGroups: readonly PermissionGroupConfig[],
  input: AuthorizationInput,
): AuthorizationDecision {
  if (input.command.kind === "ignore") {
    return { kind: "ignore" };
  }
  const access = conversationAccess(permissionGroups, input);
  if (access.kind === "denied") {
    return access;
  }
  if (access.projectIds.length > 1) {
    return {
      kind: "project-required",
      prompt: input.command.prompt,
      projectIds: access.projectIds,
    };
  }
  const [projectId] = access.projectIds;
  if (projectId === undefined) {
    return { kind: "denied", reason: "user", userId: input.userId };
  }
  return { kind: "allowed", projectId, prompt: input.command.prompt };
}

export function authorizeProjectSelection(
  permissionGroups: readonly PermissionGroupConfig[],
  input: ProjectSelectionInput,
): ProjectSelectionDecision {
  const access = conversationAccess(permissionGroups, input);
  if (access.kind === "denied") {
    return access;
  }
  if (!access.projectIds.includes(input.projectId)) {
    return {
      kind: "denied",
      reason: "project",
      projectId: input.projectId,
      allowedProjectIds: access.projectIds,
    };
  }
  return { kind: "allowed", projectId: input.projectId };
}
