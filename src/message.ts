export type BotCommand =
  | { kind: "request"; prompt: string }
  | { kind: "ignore" };

function removeLeadingMention(content: string): string {
  return content.replace(/^@[^\s]+\s+/, "").trim();
}

export function classifyMessage(content: string): BotCommand {
  const normalized = removeLeadingMention(content.trim());
  if (normalized.length === 0) {
    return { kind: "ignore" };
  }
  return { kind: "request", prompt: normalized };
}
