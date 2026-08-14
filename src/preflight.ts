import type { BotConfig } from "./config.ts";
import { runCommand, type CommandResult, type RunCommandOptions } from "./process-runner.ts";

type CommandRunner = (options: RunCommandOptions) => Promise<CommandResult>;

export async function runPreflight(
  config: BotConfig,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const gitResult = await runner({
    command: ["git", "rev-parse", "--is-inside-work-tree"],
    cwd: config.repository.path,
    timeoutMs: 30_000,
  });
  if (gitResult.stdout.trim() !== "true") {
    throw new Error(`目标目录不是 Git 仓库：${config.repository.path}`);
  }

  const codexResult = await runner({
    command: [config.codex.binary, "login", "status"],
    cwd: config.repository.path,
    timeoutMs: 30_000,
  });
  if (!codexResult.stdout.includes("Logged in using ChatGPT")) {
    throw new Error("本地 Codex 未使用 ChatGPT 登录，请先运行 codex login");
  }
}
