import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";

import {
  CosArtifactPublisher,
  FilesystemArtifactPublisher,
  type CosClient,
} from "../src/artifact-publisher.ts";

describe("安装包发布", () => {
  it("本地模式复制安装包并返回可下载地址和校验值", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "wecom-artifact-"));
    const source = join(temporaryRoot, "Example App.dmg");
    const destination = join(temporaryRoot, "published");

    try {
      await writeFile(source, "electron-installer");
      const publisher = new FilesystemArtifactPublisher({
        directory: destination,
        downloadBaseUrl: "http://127.0.0.1:18080/artifacts",
      });

      const result = await publisher.publish(source, "task-001");

      assert.equal(await readFile(result.storedPath, "utf8"), "electron-installer");
      assert.equal(result.filename, "Example App.dmg");
      assert.equal(
        result.downloadUrl,
        "http://127.0.0.1:18080/artifacts/task-001/Example%20App.dmg",
      );
      assert.match(result.sha256, /^[a-f0-9]{64}$/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("COS 模式使用任务目录上传 115MB 级别制品并生成签名地址", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: CosClient = {
      async uploadFile(params) {
        calls.push(params);
      },
      getObjectUrl(params) {
        calls.push(params);
        return "https://signed.example/download";
      },
    };
    const publisher = new CosArtifactPublisher(
      client,
      {
        bucket: "bucket-123",
        region: "ap-beijing",
        keyPrefix: "electron-builds",
        urlExpiresSeconds: 259_200,
      },
    );

    const result = await publisher.publish("/tmp/App Setup.exe", "task-002", {
      sizeBytes: 115 * 1024 * 1024,
      sha256: "a".repeat(64),
    });

    assert.deepEqual(calls[0], {
      Bucket: "bucket-123",
      Region: "ap-beijing",
      Key: "electron-builds/task-002/App Setup.exe",
      FilePath: "/tmp/App Setup.exe",
    });
    assert.deepEqual(calls[1], {
      Bucket: "bucket-123",
      Region: "ap-beijing",
      Key: "electron-builds/task-002/App Setup.exe",
      Sign: true,
      Expires: 259_200,
      Protocol: "https:",
    });
    assert.equal(result.filename, basename("/tmp/App Setup.exe"));
    assert.equal(result.downloadUrl, "https://signed.example/download");
    assert.equal(result.sizeBytes, 115 * 1024 * 1024);
  });
});
