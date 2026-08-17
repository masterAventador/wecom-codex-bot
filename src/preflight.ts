import type { BotConfig } from "./config.ts";
import { runCommand, type CommandResult, type RunCommandOptions } from "./process-runner.ts";

type CommandRunner = (options: RunCommandOptions) => Promise<CommandResult>;

export async function runPreflight(
  config: BotConfig,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const projects = Object.entries(config.projects);
  for (const [projectId, project] of projects) {
    const gitResult = await runner({
      command: ["git", "rev-parse", "--is-inside-work-tree"],
      cwd: project.path,
      timeoutMs: 30_000,
    });
    if (gitResult.stdout.trim() !== "true") {
      throw new Error(`目标项目 ${projectId} 不是 Git 仓库：${project.path}`);
    }
  }

  const firstProject = projects[0]?.[1];
  if (firstProject === undefined) {
    throw new Error("没有登记任何目标项目");
  }

  const codexResult = await runner({
    command: [config.codex.binary, "login", "status"],
    cwd: firstProject.path,
    timeoutMs: 30_000,
  });
  const loginStatus = `${codexResult.stdout}\n${codexResult.stderr}`;
  if (!loginStatus.includes("Logged in using ChatGPT")) {
    throw new Error("本地 Codex 未使用 ChatGPT 登录，请先运行 codex login");
  }
}
