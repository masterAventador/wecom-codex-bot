import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BotConfig, RuntimeSecrets } from "../src/config.ts";
import {
  CosArtifactPublisher,
  FilesystemArtifactPublisher,
  type CosClient,
} from "../src/artifact-publisher.ts";
import { createArtifactPublisher } from "../src/publisher-factory.ts";

describe("制品发布器工厂", () => {
  it("本地配置创建文件系统发布器", () => {
    const config = {
      artifact: {
        provider: "filesystem",
        filesystem: {
          directory: "/tmp/artifacts",
          downloadBaseUrl: "http://localhost/artifacts",
        },
      },
    } as BotConfig;
    const publisher = createArtifactPublisher(config, {
      wecom: { botId: "id", secret: "secret" },
    });

    assert.ok(publisher instanceof FilesystemArtifactPublisher);
  });

  it("COS 配置只把 COS 凭证交给 COS 客户端工厂", () => {
    const config = {
      artifact: {
        provider: "cos",
        cos: {
          bucket: "bucket-123",
          region: "ap-beijing",
          keyPrefix: "builds",
          urlExpiresSeconds: 3_600,
        },
      },
    } as BotConfig;
    const secrets: RuntimeSecrets = {
      wecom: { botId: "id", secret: "wecom-secret" },
      cos: { secretId: "cos-id", secretKey: "cos-key" },
    };
    let receivedCredentials: RuntimeSecrets["cos"];
    const fakeCosClient: CosClient = {
      async uploadFile() {},
      getObjectUrl() { return "https://example"; },
    };

    const publisher = createArtifactPublisher(config, secrets, (credentials) => {
      receivedCredentials = credentials;
      return fakeCosClient;
    });

    assert.ok(publisher instanceof CosArtifactPublisher);
    assert.deepEqual(receivedCredentials, { secretId: "cos-id", secretKey: "cos-key" });
  });
});
