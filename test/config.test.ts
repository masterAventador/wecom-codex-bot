import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  loadBotConfigFile,
  parseBotConfig,
  parseRuntimeOptions,
  parseRuntimeSecrets,
} from "../src/config.ts";

const desktopProject = {
  displayName: "桌面客户端",
  path: "/tmp/electron-app",
  baseBranch: "dev",
  remote: "origin",
  fetchBeforeTask: false,
  deliveryMode: "artifact",
  installCommand: ["npm", "ci"],
  testCommand: ["npm", "test"],
  buildCommand: ["npm", "run", "dist"],
  artifactGlobs: ["release/*.dmg"],
} as const;

const validConfig = {
  projects: {
    "desktop-client": desktopProject,
    "admin-panel": {
      ...desktopProject,
      displayName: "管理后台",
      path: "/tmp/admin-panel",
      baseBranch: "main",
      buildCommand: ["pnpm", "dist"],
    },
  },
  permissionGroups: [
    {
      name: "桌面端支持组",
      allowedUserIds: ["zhangsan"],
      allowedChatIds: ["group-1"],
      allowDirectMessages: false,
      allowedProjectIds: ["desktop-client"],
    },
    {
      name: "管理员组",
      allowedUserIds: ["owner"],
      allowedChatIds: ["group-1", "group-2"],
      allowDirectMessages: true,
      allowedProjectIds: ["desktop-client", "admin-panel"],
    },
  ],
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
  it("仓库内的多项目示例配置可以直接解析", async () => {
    const content = await readFile(new URL("../config/local.example.json", import.meta.url), "utf8");
    const config = parseBotConfig(JSON.parse(content) as unknown);

    assert.ok(Object.keys(config.projects).length >= 2);
    assert.ok(config.permissionGroups.length >= 2);
  });

  it("接受项目注册表和多套权限组", () => {
    const config = parseBotConfig(validConfig);

    assert.equal(config.projects["desktop-client"]?.baseBranch, "dev");
    assert.equal(config.projects["desktop-client"]?.displayName, "桌面客户端");
    assert.deepEqual(config.projects["admin-panel"]?.buildCommand, ["pnpm", "dist"]);
    assert.equal(config.permissionGroups[1]?.name, "管理员组");
    assert.equal(config.permissionGroups[1]?.allowDirectMessages, true);
    assert.equal(config.artifact.provider, "filesystem");
  });

  it("代码交付项目不要求安装、构建和安装包配置", () => {
    const config = parseBotConfig({
      ...validConfig,
      projects: {
        "aijd-demo": {
          displayName: "AIJD测试项目",
          path: "/tmp/aijd-demo",
          baseBranch: "main",
          remote: "origin",
          fetchBeforeTask: false,
          deliveryMode: "code",
          testCommand: ["python3", "-m", "py_compile", "server.py", "jd_data.py"],
        },
      },
      permissionGroups: [{
        ...validConfig.permissionGroups[0],
        allowedProjectIds: ["aijd-demo"],
      }],
    });

    assert.equal(config.projects["aijd-demo"]?.deliveryMode, "code");
    assert.equal(config.projects["aijd-demo"]?.installCommand, undefined);
    assert.equal(config.projects["aijd-demo"]?.buildCommand, undefined);
    assert.equal(config.projects["aijd-demo"]?.artifactGlobs, undefined);
  });

  it("安装包交付项目仍然要求构建命令和安装包匹配规则", () => {
    const { buildCommand: _buildCommand, artifactGlobs: _artifactGlobs, ...incomplete } =
      desktopProject;

    assert.throws(
      () => parseBotConfig({
        ...validConfig,
        projects: { "desktop-client": incomplete },
        permissionGroups: [validConfig.permissionGroups[0]],
      }),
      /buildCommand|artifactGlobs/,
    );
  });

  it("要求每个项目配置展示名称，并拒绝重复展示名称", () => {
    const { displayName: _displayName, ...withoutDisplayName } = desktopProject;
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          projects: { ...validConfig.projects, "desktop-client": withoutDisplayName },
        }),
      /displayName/,
    );
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          projects: {
            ...validConfig.projects,
            "admin-panel": { ...validConfig.projects["admin-panel"], displayName: "桌面客户端" },
          },
        }),
      /项目展示名称不能重复/,
    );
  });

  it("拒绝空项目注册表和空权限组", () => {
    assert.throws(() => parseBotConfig({ ...validConfig, projects: {} }), /projects/);
    assert.throws(() => parseBotConfig({ ...validConfig, permissionGroups: [] }), /permissionGroups/);
  });

  it("拒绝权限组引用未登记项目", () => {
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          permissionGroups: [
            {
              ...validConfig.permissionGroups[0],
              allowedProjectIds: ["not-registered"],
            },
          ],
        }),
      /not-registered.*未在 projects 中登记/,
    );
  });

  it("拒绝重复权限组名称", () => {
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          permissionGroups: [
            validConfig.permissionGroups[0],
            { ...validConfig.permissionGroups[1], name: validConfig.permissionGroups[0].name },
          ],
        }),
      /权限组名称不能重复/,
    );
  });

  it("拒绝相对仓库路径", () => {
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          projects: {
            ...validConfig.projects,
            "desktop-client": { ...desktopProject, path: "../electron-app" },
          },
        }),
      /projects.*desktop-client.*path|项目仓库路径/,
    );
  });

  it("拒绝可能逃出工作区的安装包 glob", () => {
    assert.throws(
      () =>
        parseBotConfig({
          ...validConfig,
          projects: {
            ...validConfig.projects,
            "desktop-client": { ...desktopProject, artifactGlobs: ["../release/*.dmg"] },
          },
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

  it("每次从磁盘重新读取权限组配置", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "wecom-config-"));
    const configPath = join(temporaryRoot, "local.json");

    try {
      await writeFile(configPath, JSON.stringify(validConfig));
      assert.deepEqual(
        (await loadBotConfigFile(configPath)).permissionGroups[0]?.allowedUserIds,
        ["zhangsan"],
      );

      await writeFile(
        configPath,
        JSON.stringify({
          ...validConfig,
          permissionGroups: [
            { ...validConfig.permissionGroups[0], allowedUserIds: ["lisi"] },
            validConfig.permissionGroups[1],
          ],
        }),
      );
      assert.deepEqual(
        (await loadBotConfigFile(configPath)).permissionGroups[0]?.allowedUserIds,
        ["lisi"],
      );
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

  it("详细进度环境变量默认关闭，只接受明确的 true 或 false", () => {
    assert.deepEqual(parseRuntimeOptions({}), { verboseProgress: false });
    assert.deepEqual(
      parseRuntimeOptions({ BOT_VERBOSE_PROGRESS: "true" }),
      { verboseProgress: true },
    );
    assert.deepEqual(
      parseRuntimeOptions({ BOT_VERBOSE_PROGRESS: "false" }),
      { verboseProgress: false },
    );
    assert.throws(
      () => parseRuntimeOptions({ BOT_VERBOSE_PROGRESS: "yes" }),
      /BOT_VERBOSE_PROGRESS/,
    );
  });
});
