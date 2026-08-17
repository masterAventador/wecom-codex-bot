import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BotConfig } from "../src/config.ts";
import { runPreflight } from "../src/preflight.ts";

const config = {
  projects: {
    "desktop-client": { path: "/tmp/desktop" },
    "admin-panel": { path: "/tmp/admin" },
  },
  codex: { binary: "/opt/homebrew/bin/codex" },
} as unknown as BotConfig;

describe("启动前检查", () => {
  it("确认所有登记项目都是 Git 仓库且 Codex 使用 ChatGPT 登录", async () => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    await runPreflight(config, async (options) => {
      calls.push({ command: [...options.command], cwd: options.cwd });
      if (options.command[0] === "git") {
        return { stdout: "true\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 };
    });

    assert.deepEqual(calls, [
      { command: ["git", "rev-parse", "--is-inside-work-tree"], cwd: "/tmp/desktop" },
      { command: ["git", "rev-parse", "--is-inside-work-tree"], cwd: "/tmp/admin" },
      { command: ["/opt/homebrew/bin/codex", "login", "status"], cwd: "/tmp/desktop" },
    ]);
  });

  it("任一项目不是 Git 仓库时指出项目 ID 并阻止启动", async () => {
    await assert.rejects(
      runPreflight(config, async (options) => ({
        stdout: options.cwd === "/tmp/admin" ? "false\n" : "true\n",
        stderr: "",
        exitCode: 0,
      })),
      /admin-panel.*\/tmp\/admin/,
    );
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

  it("兼容 Codex CLI 把 ChatGPT 登录状态写到 stderr", async () => {
    await assert.doesNotReject(
      runPreflight(config, async (options) => ({
        stdout: options.command[0] === "git" ? "true\n" : "",
        stderr: options.command[0] === "git"
          ? ""
          : "WARNING: PATH alias unavailable\nLogged in using ChatGPT\n",
        exitCode: 0,
      })),
    );
  });
});
