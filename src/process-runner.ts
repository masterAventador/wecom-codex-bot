import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunCommandOptions = {
  command: readonly [string, ...string[]];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
};

export class CommandExecutionError extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    exitCode: number | null,
    stdout: string,
    stderr: string,
  ) {
    super(message);
    this.name = "CommandExecutionError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const [executable, ...args] = options.command;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new CommandExecutionError(error.message, null, stdout, stderr));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new CommandExecutionError(
            `命令执行超过 ${options.timeoutMs}ms，已终止`,
            exitCode,
            stdout,
            stderr,
          ),
        );
        return;
      }
      if (exitCode !== 0) {
        reject(
          new CommandExecutionError(
            `命令执行失败，退出码 ${exitCode ?? "unknown"}`,
            exitCode,
            stdout,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: 0 });
    });
  });
}
