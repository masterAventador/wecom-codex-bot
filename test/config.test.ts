import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadBotConfigFile, parseBotConfig, parseRuntimeSecrets } from "../src/config.ts";

const validConfig = {
  security: {
    allowedUserIds: ["zhangsan"],
    allowedChatIds: ["group-1"],
  },
  repository: {
    path: "/tmp/electron-app",
    baseBranch: "dev",
    remote: "origin",
    fetchBeforeTask: false,
    installCommand: ["npm", "ci"],
    testCommand: ["npm", "test"],
    buildCommand: ["npm", "run", "dist"],
    artifactGlobs: ["release/*.dmg"],
  },
  codex: {
    binary: "codex",
    timeoutMinutes: 45,
  },
  git: {
    commitChanges: true,
    pushBranches: false,
    branchPrefix: "bot",
    authorName: "企微修复机器人",
    authorEmail: "wecom-codex-bot@localhost",
  },
  runtime: {
    directory: "/tmp/wecom-codex-runtime",
  },
  artifact: {
    provider: "filesystem",
    filesystem: {
      directory: "/tmp/bot-artifacts",
      downloadBaseUrl: "http://127.0.0.1:18080/artifacts",
    },
  },
} as const;

describe("机器人配置", () => {
  it("接受完整的本地制品配置", () => {
    const config = parseBotConfig(validConfig);

    assert.equal(config.repository.baseBranch, "dev");
    assert.deepEqual(config.repository.installCommand, ["npm", "ci"]);
    assert.equal(config.artifact.provider, "filesystem");
  });

  it("拒绝空用户白名单", () => {
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          security: { ...validConfig.security, allowedUserIds: [] },
        }),
      /allowedUserIds/,
    );
  });

  it("拒绝相对仓库路径", () => {
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          repository: { ...validConfig.repository, path: "../electron-app" },
        }),
      /repository.path/,
    );
  });

  it("拒绝可能逃出工作区的安装包 glob", () => {
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          repository: { ...validConfig.repository, artifactGlobs: ["../release/*.dmg"] },
        }),
      /artifactGlobs/,
    );
  });

  it("拒绝未提交却要求推送分支的矛盾配置", () => {
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          git: { ...validConfig.git, commitChanges: false, pushBranches: true },
        }),
      /pushBranches/,
    );
  });

  it("每次从磁盘重新读取白名单配置", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "wecom-config-"));
    const configPath = join(temporaryRoot, "local.json");

    try {
      await writeFile(configPath, JSON.stringify(validConfig));
      assert.deepEqual((await loadBotConfigFile(configPath)).security.allowedUserIds, ["zhangsan"]);

      await writeFile(
        configPath,
        JSON.stringify({
          ...validConfig,
          security: { ...validConfig.security, allowedUserIds: ["lisi"] },
        }),
      );
      assert.deepEqual((await loadBotConfigFile(configPath)).security.allowedUserIds, ["lisi"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("COS 模式要求 COS 密钥，本地模式不要求", () => {
    const localConfig = parseBotConfig(validConfig);
    assert.deepEqual(
      parseRuntimeSecrets(localConfig, {
        WECOM_BOT_ID: "bot-id",
        WECOM_BOT_SECRET: "bot-secret",
      }),
      { wecom: { botId: "bot-id", secret: "bot-secret" } },
    );

    const cosConfig = parseBotConfig({
      ...validConfig,
      artifact: {
        provider: "cos",
        cos: {
          bucket: "bucket-123",
          region: "ap-beijing",
          keyPrefix: "electron-builds",
          urlExpiresSeconds: 259_200,
        },
      },
    });
    assert.throws(
      () =>
        parseRuntimeSecrets(cosConfig, {
          WECOM_BOT_ID: "bot-id",
          WECOM_BOT_SECRET: "bot-secret",
        }),
      /COS_SECRET_ID/,
    );
  });
});
