import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CommandExecutionError, runCommand } from "../src/process-runner.ts";

describe("子进程执行器", () => {
  it("按参数数组执行命令且不经过 shell", async () => {
    const result = await runCommand({
      command: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "$(uname)"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });

    assert.equal(result.stdout, "$(uname)");
    assert.equal(result.exitCode, 0);
  });

  it("保留失败命令的退出码和标准错误", async () => {
    await assert.rejects(
      runCommand({
        command: [process.execPath, "-e", "process.stderr.write('boom');process.exit(7)"],
        cwd: process.cwd(),
        timeoutMs: 2_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CommandExecutionError);
        assert.equal(error.exitCode, 7);
        assert.equal(error.stderr, "boom");
        return true;
      },
    );
  });
});
