import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { findNewestArtifact } from "../src/artifact-locator.ts";

describe("构建产物定位", () => {
  it("只在工作区内按配置匹配并选择最新安装包", async () => {
    const root = await mkdtemp(join(tmpdir(), "wecom-build-"));
    const release = join(root, "release");

    try {
      await mkdir(release);
      const oldArtifact = join(release, "old.dmg");
      const newArtifact = join(release, "new.dmg");
      await writeFile(oldArtifact, "old");
      await writeFile(newArtifact, "new");
      await utimes(oldArtifact, new Date(1_000), new Date(1_000));
      await utimes(newArtifact, new Date(2_000), new Date(2_000));

      assert.equal(await findNewestArtifact(root, ["release/*.dmg"]), newArtifact);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("没有匹配文件时明确失败", async () => {
    const root = await mkdtemp(join(tmpdir(), "wecom-build-empty-"));
    try {
      await assert.rejects(findNewestArtifact(root, ["release/*.exe"]), /没有找到安装包/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
