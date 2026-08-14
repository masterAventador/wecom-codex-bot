import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BotConfig } from "../src/config.ts";
import { runPreflight } from "../src/preflight.ts";

const config = {
  repository: { path: "/tmp/repository" },
  codex: { binary: "/opt/homebrew/bin/codex" },
} as BotConfig;

describe("启动前检查", () => {
  it("确认目标目录是 Git 仓库且 Codex 使用 ChatGPT 登录", async () => {
    const commands: string[][] = [];
    await runPreflight(config, async (options) => {
      commands.push([...options.command]);
      if (options.command[0] === "git") {
        return { stdout: "true\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 };
    });

    assert.deepEqual(commands, [
      ["git", "rev-parse", "--is-inside-work-tree"],
      ["/opt/homebrew/bin/codex", "login", "status"],
    ]);
  });

  it("Codex 未登录时阻止启动", async () => {
    await assert.rejects(
      runPreflight(config, async (options) => ({
        stdout: options.command[0] === "git" ? "true\n" : "Not logged in\n",
        stderr: "",
        exitCode: 0,
      })),
      /未使用 ChatGPT 登录/,
    );
  });
});
