# 企微 Codex 自动修复机器人

这是一个只在本机运行的 TypeScript 服务。群成员在企业微信群里 `@机器人` 直接描述问题后，服务会按发送者、会话和项目权限校验，再到预先登记的目标项目中创建独立 Git worktree，调用本机已登录的 Codex 修改代码并运行测试。默认只修改、测试和交付代码；只有消息明确要求打包或部署时，外层服务才会执行项目预先配置的对应命令。

一个机器人进程可以管理多个代码项目和多套权限组。服务只建立到企业微信的出站 WebSocket 长连接，不需要公网 IP、域名或回调服务器。

## 已实现能力

- 使用企业微信智能机器人 WebSocket Node SDK 收发消息。
- 使用项目注册表管理多个代码仓库，群消息不能传入任意电脑路径。
- 群聊按 `userid + chatid` 找到权限组，再将命中的项目权限取并集；私聊必须由权限组显式开启。
- 群成员只需自然描述问题，不需要记忆或输入任何斜杠命令和项目 ID。
- 只有一个可用项目时直接创建任务；有多个项目时回复企微选择卡片，按钮显示项目中文名称。
- 卡片点击时再次校验点击者、群聊和项目权限，其他人不能代替发起者选择。
- 支持引用企微中的文本、图片、图文、语音和文件消息后再 `@机器人`，引用内容会一并交给 Codex。
- 每条消息到达时重新读取权限组配置，修改白名单不需要重启。
- 相同 `msgid` 在当前进程内只执行一次，所有项目的任务统一串行排队。
- 每个任务在目标仓库的 `wt/<任务编号>` 中创建独立 worktree 和 `bot/<任务编号>` 分支。
- 群内任务名称由只读 Codex 根据问题生成，格式为 `月日-十二字以内摘要`；内部 Git 安全编号不会作为群消息主标题。
- 通过当前 macOS 用户的 ChatGPT 登录调用本地 Codex，不需要 OpenAI API Key 或 API 代理。
- 消息先经过只读分流：代码修改才创建 worktree；项目介绍、架构、代码含义和进度问题会直接只读回答；确实无法理解修改目标时才要求补充信息。
- 支持群内文字和图文混排反馈；附件只有通过完整权限校验后才下载，任务结束后自动删除。
- 每个项目可选择 `code` 或 `artifact` 能力；普通消息一律只交付代码，`artifact` 项目只有在消息明确要求“打包/出包”时才构建并发布 Electron 安装包。
- 部署只响应明确的“部署/上线/发布”请求，并且只能执行项目预先登记的 `deployCommand`；没有配置时安全拒绝。
- 支持腾讯云 COS 上传 115MB 等大安装包，并生成限时签名下载地址。
- 可选择成功后自动快进合并到预设基础分支；失败任务始终保留独立分支和 worktree。
- 默认只发送入队回执和最终结果；最终群消息按本地姓名映射显示 `@姓名`，并隐藏详细原因和执行命令。
- 企微和 COS 密钥不会传入 Codex，也不会传给目标项目的安装、测试和构建命令。

## 群聊和私聊用法

```text
@机器人 登录按钮点了没反应，控制台报错见截图
```

- 如果发送者在当前群只有一个可用项目，机器人会直接创建任务。
- 如果有多个可用项目，机器人会回复项目选择卡片；点击“桌面客户端”“管理后台”等展示名称后才创建任务。
- 项目选择卡片保留 5 分钟；超时或服务重启后需要重新描述问题。
- 项目 ID 是本地配置中的稳定键，只供服务内部鉴权和定位仓库使用，群成员不需要知道它。
- 群聊中企业微信只会把 `@机器人` 的消息交给机器人；后续没有再次 `@` 的补充消息通常收不到。可以把信息写在同一条消息中，或引用前一条消息后再次 `@机器人`。
- 私聊机器人时，每条消息都能收到，不需要 `@`；但对应权限组必须设置 `allowDirectMessages: true`。
- 斜杠文本没有特殊含义，例如 `/fix ...` 会被当成普通问题描述原样交给 Codex，不建议再使用。
- 任务最终消息使用本地 `userid → 姓名` 映射显示原发起人，不查询通讯录；私聊不会添加 `@`。这是普通文字，不会触发企微原生提及提醒。

也可以先引用群里的报错、截图、语音或日志文件，再发送：

```text
@机器人 根据引用内容修复这个问题
```

引用文本和语音转写会进入问题上下文；引用图片会作为 Codex 图片附件；引用文件会在权限校验后下载到独立 worktree 的临时目录，Codex 完成或失败后都会在 Git 检查前删除。企微引用结构不包含原消息发送者信息，因此 Codex 能看到被引用的内容和类型，但看不到原发送者的姓名或 userid。

## 工作流程

```text
群成员引用反馈消息并 @机器人，自然描述问题
        ↓
userid + 群聊 chatid / 私聊开关权限校验
        ↓
单项目直接执行 / 多项目点击中文名称选择卡片
        ↓
从项目注册表读取固定仓库路径和命令
        ↓
进入本机串行任务队列
        ↓
只读 Codex 生成月日 + 十二字以内任务摘要
        ↓
只读分流：modify / answer / clarify
        ↓
answer：检查仓库后直接答疑，不创建 worktree
clarify：要求补充信息，不创建 worktree
modify：继续代码流水线
        ↓
目标仓库/wt/任务编号 + bot/任务编号分支
        ↓
可选安装依赖 → Codex 测试先行修改 → 外层测试
        ↓
默认：Git 提交 → 快进合并基础分支 → 清理任务 worktree
        ↓
明确要求打包：Electron 构建 → 上传 COS → 再合并
明确要求部署：合并后执行项目预设 deployCommand
未明确要求：绝不主动打包或部署
```

任何合并前环节失败都会停止后续交付，并在原会话返回错误摘要；任务分支和 worktree 会保留，方便人工接管。部署发生在成功合并和清理之后，因此部署命令失败时消息会明确说明“代码已合并，但部署失败”。

如果消息看起来想改代码，但结合文字、截图、引用内容和仓库信息仍无法确认修改目标，机器人会回复一个最需要补充的问题，并提示：`群聊中请引用本消息并再次 @我。` 项目答疑和普通交流不会进入这个兜底。

## 环境要求

- Node.js 20 或更高版本。
- Git。
- 可以正常测试所有登记项目；使用 `artifact` 模式时还要具备完整 Electron 构建环境。
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

企微智能机器人收到的每条消息都包含发送者的 `from.userid`，群消息还包含 `chatid`，不需要专门设计 `/whoami` 命令。

- `userid` 可以在企微管理后台通讯录的成员账号中查看，也可以通过通讯录 API 获取。
- `chatid` 可以从智能机器人收到的群消息事件中取得。
- 本服务也提供了无命令的引导方式：群聊鉴权失败时，拒绝消息会同时带出当前发送者的 `userid` 和当前群的 `chatid`，可以一次性复制到权限组配置；私聊鉴权失败时只显示 `userid`。

把拿到的值填进 `allowedUserIds` 和 `allowedChatIds` 即可。机器人只回显当前发送者自己的 `userid`，不会查询或枚举公司通讯录。

如果希望最终群消息显示可读姓名，可在 `config/local.json` 顶层增加映射：

```json
{
  "userDisplayNames": {
    "woay8AEgAAw8MXiWiwMvDhA3H4jAQJWg": "魏帅"
  }
}
```

长连接智能机器人的主动消息不提供 `mentioned_list`，所以这里的 `@魏帅` 只是可读文本，不会产生企微原生强提醒。未配置姓名的 userid 不会出现在最终群消息中。

## 登记多个项目

编辑 `config/local.json` 的 `projects`。`desktop-client` 这样的键就是你自己定义的 `projectId`，建议采用简短稳定的英文标识；`displayName` 是企微卡片和任务消息里给同事看的名称：

```json
{
  "projects": {
    "desktop-client": {
      "displayName": "桌面客户端",
      "path": "/Users/你的用户名/代码/electron-desktop-client",
      "baseBranch": "dev",
      "remote": "origin",
      "fetchBeforeTask": true,
      "deliveryMode": "artifact",
      "installCommand": ["npm", "ci"],
      "testCommand": ["npm", "test"],
      "buildCommand": ["npm", "run", "dist"],
      "artifactGlobs": ["release/*.dmg", "release/*.exe"],
      "deployCommand": ["./scripts/deploy.sh", "staging"]
    },
    "backend-service": {
      "displayName": "后端服务",
      "path": "/Users/你的用户名/代码/backend-service",
      "baseBranch": "main",
      "remote": "origin",
      "fetchBeforeTask": true,
      "deliveryMode": "code",
      "installCommand": ["pnpm", "install", "--frozen-lockfile"],
      "testCommand": ["pnpm", "test"]
    }
  }
}
```

安全限制：

- `path` 必须是绝对路径。
- 项目 ID 只能包含字母、数字、点、下划线和连字符，最长 64 个字符。
- `displayName` 必填、不能重复，最长 30 个字符；修改它不会改变仓库定位或权限配置。
- `deliveryMode` 可设为 `code` 或 `artifact`；它表示项目是否具备安装包能力，不代表每次任务都会打包。旧配置省略时按 `artifact` 处理。
- `testCommand` 必填；`installCommand` 可省略；命令必须写成参数数组，不经过 shell。
- `artifact` 项目必须配置 `buildCommand` 和 `artifactGlobs`；只有群消息明确要求“打包/出包”才会使用。`artifactGlobs` 只能匹配工作区内部文件，不能使用绝对路径或 `..`。
- `deployCommand` 可省略。只有明确要求“部署/上线/发布”、已配置固定命令且启用了 `git.mergeToBaseBranch` 时才会从基础仓库执行；消息文字不能改变命令参数。
- “不要打包”“不用部署”“部署后报错”“打包失败”等否定或问题背景不会触发交付动作。未识别的说法安全降级为只修改代码。
- 服务启动时会逐个确认登记目录是 Git 仓库。

## 配置权限组

`permissionGroups` 可以配置任意多组权限。群聊需要同时命中发送者 `userid` 和当前群 `chatid`；私聊需要命中 `userid` 且该组明确设置 `allowDirectMessages: true`。最终只能选择命中权限组中登记的项目：

```json
{
  "permissionGroups": [
    {
      "name": "桌面端支持组",
      "allowedUserIds": ["zhangsan", "lisi"],
      "allowedChatIds": ["wr_weekend_feedback"],
      "allowDirectMessages": false,
      "allowedProjectIds": ["desktop-client"]
    },
    {
      "name": "负责人全项目组",
      "allowedUserIds": ["owner"],
      "allowedChatIds": ["wr_weekend_feedback", "wr_development"],
      "allowDirectMessages": true,
      "allowedProjectIds": ["desktop-client", "backend-service"]
    }
  ]
}
```

匹配规则：

- 同一用户和群命中多个权限组时，可操作项目取这些权限组的并集。
- 一个权限组里的用户列表和群列表是组合授权：列表中的任意用户都能在列表中的任意群操作该组项目。需要更严格组合时应拆成多个权限组。
- `allowDirectMessages` 只控制该组用户能否私聊触发任务，不会放宽群聊的 `chatid` 校验；省略时默认为 `false`。
- 同一用户在同一群或私聊中最终匹配的项目不能超过 6 个，这是企业微信按钮卡片的上限；超过时机器人会拒绝创建任务并提示调整权限组。
- 权限组名称不能重复，`allowedProjectIds` 必须全部存在于 `projects`。
- 权限组在每条消息到达时重新读取，保存配置后不用重启。
- 新增或修改项目路径后建议重启服务，让启动前检查覆盖新仓库。
- 未授权用户不会创建 worktree、下载附件或调用 Codex。

旧版配置中的顶层 `security` 和 `repository` 已被 `permissionGroups` 和 `projects` 取代，请按 `config/local.example.json` 迁移。

## 配置腾讯云 COS

115MB Electron 安装包超过企微智能机器人 SDK 当前约 50MB 的媒体上传实现上限，因此需要响应明确打包请求的 `artifact` 项目正式使用应选择 COS 模式。只有 `code` 项目时可保留本地 `filesystem` 配置，它不会被普通代码任务使用。

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

# 默认 false；设为 true 才把 worktree、Codex 命令等过程发送到企微
BOT_VERBOSE_PROGRESS=false
```

底层使用企业微信团队维护的 [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)，连接地址默认为 `wss://openws.work.weixin.qq.com`。

`BOT_VERBOSE_PROGRESS=false` 时，企微只保留入队回执和最终成功/失败消息；设为 `true` 后才发送详细过程。环境变量只接受 `true` 或 `false`，修改后需要重启服务。

## Git 行为

```json
{
  "git": {
    "commitChanges": true,
    "pushBranches": false,
    "mergeToBaseBranch": true,
    "branchPrefix": "bot",
    "authorName": "企微修复机器人",
    "authorEmail": "wecom-codex-bot@localhost"
  }
}
```

- `mergeToBaseBranch=true`：测试以及消息明确要求的构建、制品上传全部成功后，使用 `--ff-only` 合并回项目的 `baseBranch`，然后删除任务 worktree 和本地任务分支。启动服务时，基础仓库必须已检出该分支且工作区干净。
- `mergeToBaseBranch=false`：保留本地任务分支和 worktree，便于人工检查。
- `pushBranches=true`：项目门禁通过后推送到目标项目配置的远端，必须同时启用 `commitChanges`。
- `mergeToBaseBranch=true` 必须同时启用 `commitChanges`，且不能同时启用 `pushBranches`；当前只合并到本地，不会自动推送或部署。
- 任务失败或无法快进合并时，会保留相应项目 `wt/` 下的 worktree 和任务分支，供人工排查。

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

使用 `Ctrl+C` 停止。项目不会配置开机自启或后台常驻服务。开发时可以运行 `npm run dev`。

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

- 所有项目共用一个串行队列；一个任务完成后才会处理下一个任务。
- `msgid` 去重保存在内存中，服务重启后会清空；Git 分支名仍会阻止同一任务被无声覆盖。
- 未点击的项目选择状态只在内存中保留 5 分钟；服务重启后旧卡片也会失效。
- 电脑休眠、关机或断网时机器人不可用。
- Windows 安装包如果依赖原生模块，建议在 Windows 机器上构建和验收。
- macOS 安装包仍需要正确配置 Developer ID 签名和公证；Windows 安装包建议配置代码签名证书。
- 没有企微和 COS 真实凭证时，只能验证本地任务链路，不能宣称外部收发与上传已经联调通过。
- 让多人通过一个人的个人 ChatGPT 订阅持续使用 Codex，存在账户使用条款风险；团队长期使用应评估 OpenAI 的企业或 API 授权方案。

## 安全设计

- 用户、会话和项目权限检查发生在引用图片/文件下载、Git、Codex、测试和构建之前；项目卡片点击时还会再次检查。
- 项目仓库只能来自本地 `projects` 注册表，群成员不能指定文件系统路径或任意构建命令。
- Codex 使用自动审批的 `workspace-write` 沙箱，不使用 `danger-full-access`。
- 生成群聊任务摘要的独立 Codex 调用使用 `read-only` 沙箱，失败时降级为清洗后的问题描述，不阻止代码任务。
- 群反馈被包裹为“不可信问题描述”，不能覆盖外层工作要求。
- 引用文本同样属于不可信问题描述；引用文件仅临时只读检查，文件名会清洗，且不会进入 Git 提交。
- Codex 环境只继承登录和基本系统变量，不包含企微、COS、签名或项目发布密钥。
- 目标项目命令会继承项目构建所需环境，但明确移除企微和 COS 密钥。
- COS 和企微密钥经过日志脱敏，不写入配置文件和 Git。
- 所有外部命令使用可执行文件和参数数组调用，不拼接群消息，不经过 shell。
