const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export type BotCommand =
  | { kind: "identity" }
  | { kind: "projects" }
  | { kind: "request"; prompt: string; projectId?: string }
  | { kind: "usage" }
  | { kind: "ignore" };

function removeLeadingMention(content: string): string {
  return content.replace(/^@[^\s]+\s+/, "").trim();
}

export function classifyMessage(content: string): BotCommand {
  const normalized = removeLeadingMention(content.trim());
  if (normalized.length === 0) {
    return { kind: "ignore" };
  }
  if (/^\/whoami(?:\s|$)/i.test(normalized)) {
    return { kind: "identity" };
  }
  if (/^\/projects(?:\s|$)/i.test(normalized)) {
    return { kind: "projects" };
  }
  if (/^\/fix(?:\s|$)/i.test(normalized)) {
    const match = normalized.match(/^\/fix\s+(\S+)\s+([\s\S]+)$/i);
    const projectId = match?.[1];
    const prompt = match?.[2]?.trim();
    if (projectId === undefined || prompt === undefined || !PROJECT_ID_PATTERN.test(projectId)) {
      return { kind: "usage" };
    }
    return { kind: "request", projectId, prompt };
  }
  return { kind: "request", prompt: normalized };
}
