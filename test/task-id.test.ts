import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTaskDisplayName, createTaskId } from "../src/task-id.ts";

describe("任务编号", () => {
  it("包含本地时间和安全的消息短标识", () => {
    assert.equal(
      createTaskId("msg/with unsafe spaces", new Date("2026-08-14T10:30:45+08:00")),
      "20260814-103045-msgwithu",
    );
  });

  it("群聊展示名称只保留月日，并限制摘要最多十二个字符", () => {
    assert.equal(
      createTaskDisplayName("README标题加标记", new Date("2026-08-17T11:45:58+08:00")),
      "0817-README标题加标记",
    );
    assert.equal(
      createTaskDisplayName("一二三四五六七八九十一二三四", new Date("2026-08-17T11:45:58+08:00")),
      "0817-一二三四五六七八九十一二",
    );
  });

  it("降级任务名称会移除群消息中的提及、换行和 Markdown", () => {
    assert.equal(
      createTaskDisplayName("<@all>\n# 删除代码", new Date("2026-08-17T11:45:58+08:00")),
      "0817-all删除代码",
    );
  });
});
