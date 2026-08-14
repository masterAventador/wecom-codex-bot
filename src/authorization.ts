import type { SecurityConfig } from "./config.ts";
import type { BotCommand } from "./message.ts";

type AuthorizationInput = {
  command: BotCommand;
  userId: string;
  chatId?: string;
};

export type AuthorizationDecision =
  | { kind: "identity"; userId: string; chatId?: string }
  | { kind: "ignore" }
  | { kind: "denied"; reason: "chat" }
  | { kind: "denied"; reason: "user"; userId: string }
  | { kind: "allowed"; prompt: string };

export function authorizeMessage(
  security: SecurityConfig,
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
  if (input.chatId === undefined || !security.allowedChatIds.includes(input.chatId)) {
    return { kind: "denied", reason: "chat" };
  }
  if (!security.allowedUserIds.includes(input.userId)) {
    return { kind: "denied", reason: "user", userId: input.userId };
  }
  return { kind: "allowed", prompt: input.command.prompt };
}
