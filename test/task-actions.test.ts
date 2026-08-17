import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectTaskActions } from "../src/task-actions.ts";

describe("自然语言交付动作", () => {
  it("普通代码反馈默认不打包也不部署", () => {
    assert.deepEqual(detectTaskActions("登录按钮点了没反应，帮我修一下"), {
      packageArtifact: false,
      deploy: false,
      codeChange: true,
    });
  });

  it("只有明确提出时才请求打包或部署", () => {
    assert.deepEqual(detectTaskActions("改完后帮我打个安装包，再部署到测试环境"), {
      packageArtifact: true,
      deploy: true,
      codeChange: false,
    });
    assert.deepEqual(detectTaskActions("打包一下"), {
      packageArtifact: true,
      deploy: false,
      codeChange: false,
    });
    assert.deepEqual(detectTaskActions("部署一下"), {
      packageArtifact: false,
      deploy: true,
      codeChange: false,
    });
  });

  it("否定表达和故障背景不会误触发", () => {
    assert.deepEqual(detectTaskActions("部署后页面白屏，不要打包，也不用重新部署"), {
      packageArtifact: false,
      deploy: false,
      codeChange: true,
    });
    assert.deepEqual(detectTaskActions("打包失败，修一下构建脚本"), {
      packageArtifact: false,
      deploy: false,
      codeChange: true,
    });
    assert.equal(detectTaskActions("部署脚本读取环境变量失败").deploy, false);
  });

  it("同时包含实际问题和交付动作时仍要求修改代码", () => {
    assert.deepEqual(detectTaskActions("修复启动白屏，改完后打个安装包"), {
      packageArtifact: true,
      deploy: false,
      codeChange: true,
    });
  });
});
