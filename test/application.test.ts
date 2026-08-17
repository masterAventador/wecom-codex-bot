import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ArtifactPublisher } from "../src/artifact-publisher.ts";
import { startApplication } from "../src/application.ts";
import type { EventedWeComClient } from "../src/wecom-gateway.ts";

const config = {
  projects: {
    "desktop-client": {
      displayName: "桌面客户端",
      path: "/tmp/repository",
      baseBranch: "dev",
      remote: "origin",
      fetchBeforeTask: false,
      deliveryMode: "artifact",
      installCommand: ["npm", "ci"],
      testCommand: ["npm", "test"],
      buildCommand: ["npm", "run", "dist"],
      artifactGlobs: ["release/*.dmg"],
    },
  },
  permissionGroups: [{
    name: "支持组",
    allowedUserIds: ["owner"],
    allowedChatIds: ["group"],
    allowDirectMessages: false,
    allowedProjectIds: ["desktop-client"],
  }],
  codex: { binary: "codex", timeoutMinutes: 45 },
  git: {
    commitChanges: true,
    pushBranches: false,
    branchPrefix: "bot",
    authorName: "企微修复机器人",
    authorEmail: "wecom-codex-bot@localhost",
  },
  runtime: { directory: "/tmp/runtime" },
  artifact: {
    provider: "filesystem",
    filesystem: {
      directory: "/tmp/artifacts",
      downloadBaseUrl: "http://localhost/artifacts",
    },
  },
};

describe("应用启动", () => {
  it("读取配置、执行预检、创建依赖并连接企微", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "wecom-application-"));
    const configPath = join(temporaryRoot, "local.json");
    const events: string[] = [];
    const listeners = new Map<string, (payload: unknown) => Promise<void> | void>();
    const client: EventedWeComClient = {
      async replyStream() {},
      async replyTemplateCard() {},
      async updateTemplateCard() {},
      async sendMessage() {},
      async downloadFile() { return { buffer: Buffer.alloc(0) }; },
      on(event, listener) { listeners.set(event, listener); return this; },
      connect() { events.push("connect"); return this; },
      disconnect() { events.push("disconnect"); },
    };
    const publisher: ArtifactPublisher = {
      async publish() { throw new Error("测试不执行任务"); },
    };

    try {
      await writeFile(configPath, JSON.stringify(config));
      const application = await startApplication({
        configPath,
        environment: {
          WECOM_BOT_ID: "bot-id",
          WECOM_BOT_SECRET: "bot-secret",
        },
        logger: { info: () => undefined, error: () => undefined },
        dependencies: {
          async preflight(loadedConfig) {
            events.push(`preflight:${loadedConfig.projects["desktop-client"]?.baseBranch}`);
          },
          createPublisher(_loadedConfig, secrets) {
            events.push(`publisher:${secrets.wecom.botId}`);
            return publisher;
          },
          createWeComClient(secrets) {
            events.push(`client:${secrets.wecom.secret}`);
            return client;
          },
          createStreamId: () => "stream-id",
        },
      });

      assert.deepEqual(events, [
        "preflight:dev",
        "publisher:bot-id",
        "client:bot-secret",
        "connect",
      ]);
      assert.ok(listeners.has("message.text"));
      application.stop();
      assert.equal(events.at(-1), "disconnect");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
