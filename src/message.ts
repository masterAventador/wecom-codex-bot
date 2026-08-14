export type BotCommand =
  | { kind: "identity" }
  | { kind: "request"; prompt: string }
  | { kind: "ignore" };

export function classifyMessage(content: string): BotCommand {
  const normalized = content.trim();
  if (normalized.length === 0) {
    return { kind: "ignore" };
  }
  if (/^(?:@[^\s]+\s+)?\/whoami(?:\s|$)/i.test(normalized)) {
    return { kind: "identity" };
  }
  return { kind: "request", prompt: normalized };
}
