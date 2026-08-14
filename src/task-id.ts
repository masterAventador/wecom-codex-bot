function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function createTaskId(messageId: string, now = new Date()): string {
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  const messageSuffix = messageId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "message";
  return `${timestamp}-${messageSuffix}`;
}
