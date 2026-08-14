# 企微 Codex 自动修复机器人

这是一个只在本机运行的 TypeScript 服务。群成员在企业微信群里 `@机器人` 反馈问题后，服务会在独立 Git worktree 中调用本机已登录的 Codex 修改代码，运行项目测试，构建 Electron 安装包，上传到对象存储，再把下载链接发回原群。

服务只建立到企业微信的出站 WebSocket 长连接，不需要公网 IP、域名或回调服务器。

## 已实现能力

- 使用企业微信智能机器人 WebSocket Node SDK 收发消息。
- 同时校验群成员 `userid` 和群 `chatid` 白名单。
- `/whoami` 只返回当前 `userid` 和 `chatid`，永远不会触发代码任务。
- 相同 `msgid` 在当前进程内只执行一次。
- 所有任务串行执行，避免同时修改同一个仓库。
- 每个任务在目标仓库的 `wt/<任务编号>` 中创建独立 worktree 和 `bot/<任务编号>` 分支。
- 通过当前 macOS 用户的 ChatGPT 登录调用本地 Codex，不需要 OpenAI API Key。
- 支持群内文字和图文混排反馈；图片只有通过白名单后才会下载，任务结束后自动删除。
- Codex 修改完成后，由外层服务独立执行测试和 Electron 打包命令。
- 支持腾讯云 COS 上传 115MB 等大安装包，并生成限时签名下载地址。
- 可选择自动提交、自动推送任务分支；永远不会自动合并主分支。
- 企微和 COS 密钥不会传入 Codex，也不会传给目标项目的安装、测试和构建命令。

## 工作流程

```text
群成员 @机器人反馈问题
        ↓
userid + chatid 白名单校验
        ↓
进入本机串行任务队列
        ↓
目标仓库/wt/任务编号 + bot/任务编号分支
        ↓
安装依赖 → Codex 测试先行修改 → 外层测试
        ↓
Electron 构建 → Git 提交/可选推送
        ↓
上传 COS → 企微群发送下载链接和修改摘要
```

任何环节失败都会停止后续发布，并在群里返回失败阶段和错误摘要。失败任务的分支和 worktree 会保留，方便人工接管。

## 环境要求

- Node.js 20 或更高版本。
- Git。
- 可以正常构建目标 Electron 项目的完整本地环境。
- 已安装并登录 Codex CLI：

```bash
codex login
codex login status
```

第二条命令应显示 `Logged in using ChatGPT`。OpenAI 官方文档说明 Codex CLI 支持使用 ChatGPT 订阅登录：[Codex Authentication](https://learn.chatgpt.com/docs/auth)。

## 安装

```bash
cd /Users/aventador/sourceCode/wecom-codex-bot
npm install
cp .env.example .env
cp config/local.example.json config/local.json
```

`.env` 和 `config/local.json` 已加入 `.gitignore`，不会提交到 Git。

## 获取 userid 和 chatid

企微智能机器人收到的每条消息都包含发送者的 `from.userid`，群消息还包含 `chatid`。

第一次启动时，可以暂时在 `config/local.json` 中保留示例占位值。把机器人加入目标群后发送：

```text
@机器人 /whoami
```

机器人会回复：

```text
你的 userid：zhangsan
当前 chatid：wrxxxxxxxx
```

把结果写入：

```json
{
  "security": {
    "allowedUserIds": ["zhangsan", "lisi"],
    "allowedChatIds": ["wrxxxxxxxx"]
  }
}
```

白名单在每条消息到达时重新读取，保存配置后不用重启服务。未授权用户只能看到自己的 `userid`，不会创建 Git worktree，也不会调用 Codex。

## 配置目标 Electron 项目

编辑 `config/local.json`：

```json
{
  "repository": {
    "path": "/Users/你的用户名/代码/electron-project",
    "baseBranch": "dev",
    "remote": "origin",
    "fetchBeforeTask": true,
    "installCommand": ["npm", "ci"],
    "testCommand": ["npm", "test"],
    "buildCommand": ["npm", "run", "dist"],
    "artifactGlobs": ["release/*.dmg", "release/*.exe"]
  }
}
```

命令必须写成参数数组，不经过 shell。这样群消息不会被拼接成终端命令。

如果项目使用 pnpm，可以改为：

```json
{
  "installCommand": ["pnpm", "install", "--frozen-lockfile"],
  "testCommand": ["pnpm", "test"],
  "buildCommand": ["pnpm", "dist"]
}
```

`artifactGlobs` 只允许工作区内的相对路径，不能包含 `..`。

## 配置腾讯云 COS

115MB Electron 安装包超过企微智能机器人 SDK 当前约 50MB 的媒体上传实现上限，因此正式使用应选择 COS 模式。

在 `.env` 填写：

```dotenv
COS_SECRET_ID=你的SecretId
COS_SECRET_KEY=你的SecretKey
```

在 `config/local.json` 填写：

```json
{
  "artifact": {
    "provider": "cos",
    "cos": {
      "bucket": "example-1234567890",
      "region": "ap-beijing",
      "keyPrefix": "electron-builds",
      "urlExpiresSeconds": 259200
    }
  }
}
```

建议使用私有 Bucket，并给机器人创建只能向指定前缀上传和读取的最小权限子账号。群里收到的是有期限的签名地址，不要把 Bucket 设置成永久公共读。

`filesystem` 发布模式只用于本机测试。它会复制安装包并拼接 `downloadBaseUrl`，但本项目不会自动暴露本机 HTTP 服务。

## 配置企业微信机器人

在 `.env` 填写企业微信后台提供的智能机器人凭证：

```dotenv
WECOM_BOT_ID=你的BotID
WECOM_BOT_SECRET=你的Secret
```

底层使用企业微信团队维护的 [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)，连接地址默认为 `wss://openws.work.weixin.qq.com`。

## Git 行为

```json
{
  "git": {
    "commitChanges": true,
    "pushBranches": false,
    "branchPrefix": "bot",
    "authorName": "企微修复机器人",
    "authorEmail": "wecom-codex-bot@localhost"
  }
}
```

- `pushBranches=false`：只保留本地任务分支，适合第一阶段验证。
- `pushBranches=true`：测试和构建通过后推送到配置的远端。必须同时启用 `commitChanges`。
- 服务不会自动合并 `dev`、`master` 或 `main`。
- worktree 会保留在目标项目的 `wt/` 下，确认不再需要后可人工执行 `git worktree remove <路径>`。

## 启动与停止

先执行完整检查和构建：

```bash
npm run check
```

前台启动：

```bash
npm start
```

如果周末需要防止 Mac 休眠，可以手动以前台方式运行：

```bash
caffeinate -dimsu npm start
```

使用 `Ctrl+C` 停止。项目不会配置开机自启或后台常驻服务。

开发时可以运行：

```bash
npm run dev
```

## 测试

```bash
npm test
npm run typecheck
npm run build
```

完整本地流水线测试会创建临时 Git 仓库、执行测试和构建，并生成、复制和校验一个 115MB 安装包：

```bash
RUN_LOCAL_PIPELINE_E2E=1 node --experimental-strip-types --test test/local-codex-e2e.test.ts
```

使用真实本机 Codex 的可选测试：

```bash
RUN_LOCAL_CODEX_E2E=1 node --experimental-strip-types --test test/local-codex-e2e.test.ts
```

真实测试会消耗 Codex 订阅额度，并允许 Codex 在临时测试仓库内执行命令，应只在你自己的终端中运行。

## 当前边界

- 当前只配置一个目标代码仓库。
- `msgid` 去重保存在内存中，服务重启后会清空；Git 分支名仍会阻止同一任务被无声覆盖。
- 电脑休眠、关机或断网时机器人不可用。
- Windows 安装包如果依赖原生模块，建议在 Windows 机器上构建和验收。
- macOS 安装包仍需要正确配置 Developer ID 签名和公证；Windows 安装包建议配置代码签名证书。
- 没有企微和 COS 真实凭证时，只能验证本地任务链路，不能宣称外部收发与上传已经联调通过。
- 让多人通过一个人的个人 ChatGPT 订阅持续使用 Codex，存在账户使用条款风险；团队长期使用应评估 OpenAI 的企业或 API 授权方案。

## 安全设计

- 白名单检查发生在附件下载、Git、Codex、测试和构建之前。
- Codex 使用自动审批的 `workspace-write` 沙箱，不使用 `danger-full-access`。
- 群反馈被包裹为“不可信问题描述”，不能覆盖外层工作要求。
- Codex 环境只继承登录和基本系统变量，不包含企微、COS、签名或项目发布密钥。
- 目标项目命令会继承项目构建所需环境，但明确移除企微和 COS 密钥。
- COS 和企微密钥经过日志脱敏，不写入配置文件和 Git。
- 所有外部命令使用可执行文件和参数数组调用，不拼接群消息，不经过 shell。
