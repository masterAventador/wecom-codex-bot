import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTaskId } from "../src/task-id.ts";

describe("任务编号", () => {
  it("包含本地时间和安全的消息短标识", () => {
    assert.equal(
      createTaskId("msg/with unsafe spaces", new Date("2026-08-14T10:30:45+08:00")),
      "20260814-103045-msgwithu",
    );
  });
});
