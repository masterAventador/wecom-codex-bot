import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SerialTaskQueue } from "../src/serial-task-queue.ts";

describe("串行任务队列", () => {
  it("按进入顺序串行执行任务", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue("msg-1", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = queue.enqueue("msg-2", async () => {
      events.push("second:start");
      return 2;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["first:start"]);
    assert.equal(first.position, 1);
    assert.equal(second.position, 2);

    releaseFirst?.();
    assert.equal(await first.completion, 1);
    assert.equal(await second.completion, 2);
    assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  });

  it("任务完成后仍拒绝相同 msgid，防止企微重试重复执行", async () => {
    const queue = new SerialTaskQueue();
    const first = queue.enqueue("same-msg", async () => "done");

    assert.equal(await first.completion, "done");
    assert.deepEqual(queue.enqueue("same-msg", async () => "again"), {
      accepted: false,
      position: 0,
      completion: null,
    });
  });
});
