# wechat-agent

基于本机 Codex 的微信 AI 助手，通过 ACP bridge 接入微信。Codex 负责对话、代码执行和联网能力，微信侧负责消息与媒体收发。

## 架构

```
微信用户 ↔ 微信服务器 ↔ weixin-acp (ACP bridge) ↔ codex-acp ↔ 本机 Codex CLI
```

- **weixin-acp**：长轮询收发微信消息，通过 JSON-RPC over stdio 与 agent 通信
- **codex-acp**：将 ACP 请求转给本机 Codex app-server
- **Codex CLI**：使用本机 Codex 登录态、模型和配置

支持多租户：每个已登录微信账号都会独立启动一个 bridge、Codex ACP 子进程和会话空间，账号之间不会共享对话上下文。

## Codex 能力

工具能力由本机 Codex 配置决定。需要联网时，请确保 Codex 启动配置启用了搜索能力。

原先 `agent.mjs` 中的工具实现现在通过 `codex-tools.mjs` 暴露给 Codex，包括 `web_search`、`run_code`、`fetch_url` 和 `create_pdf`（图片、PDF 文件可直发微信）。生成 PDF 时应先整理 Markdown，再调用 `create_pdf`，不要直接调用 Chromium。原来的 `delegate_agent` 使用 Claude API 发起第二次模型调用，当前不再暴露，由 Codex 自己处理子任务。

<!-- 旧版 Claude Agent 工具说明（当前 Codex 模式不加载 agent.mjs）
### web_search — 联网搜索

- Puppeteer 渲染百度搜索页面，从 DOM 提取结果（标题 + 真实 URL + 摘要）
- 自动解析百度跳转链接（`mu` 属性 + HEAD redirect fallback），返回目标站真实 URL
- 无 Puppeteer 时 fallback 到 DuckDuckGo lite (curl)

### fetch_url — 网页抓取 / 图片下载发送

统一入口，通过 `browserFetch()` 自动区分图片和网页：

**图片下载（任意网站通用）：**

| 层级 | 技术 | 解决的问题 |
|------|------|-----------|
| CDP Fetch 拦截 | `Fetch.getResponseBody` 在 Chromium charset 解码前获取原始字节 | 防盗链 403 + `charset=UTF-8` 二进制损坏 |
| Content-Type 自动检测 | 响应是 `image/*` 时自动走图片流程 | 无扩展名 URL、CDN 代理 URL |
| Magic bytes 验证 | 检测 JPEG/PNG/GIF/WebP 文件头，排除 HTML 伪图片 | 防盗链返回 HTML 错误页 |
| 微信直发 | `sendWechatImageDirect` 调微信 CDN 上传 + sendMessage API | 绕过 ACP ResponseCollector 单图限制 |
| ACP fallback | `agent_message_chunk` 发送 | 直发不可用时兜底 |
| curl fallback | 带 Referer 的 curl 下载 | 无 Puppeteer 环境 |

**网页抓取：**

- Puppeteer `networkidle2` 等待 JS 渲染完成
- 提取正文文本（去 script/style/标签，截断 3000 字符）
- 提取页面图片列表（`src` / `data-src` / `data-original`，排除 UI 图标，解析相对 URL）
- curl fallback

### run_code — 代码执行

- 支持 Python、Node.js、Bash
- 写入临时文件执行，2MB 输出上限，自动清理

### delegate_agent — 子 Agent 委派

- **coder**：编程助手，给出完整可运行代码
- **translator**：翻译助手，中英互译
- **analyst**：数据分析专家

每个子 Agent 使用独立的 system prompt 和单轮 LLM 调用。

## 图片收发全链路

### 发送图片到微信（出站）

```
fetch_url 调用
  → browserFetch() — CDP Fetch 拦截，获取原始字节
  → validateImage() — magic bytes 检测格式
  → sendWechatImageDirect() — 微信 CDN 上传流程：
      1. getuploadurl — 获取 CDN 上传地址
      2. AES-128-ECB 加密图片
      3. POST 到 CDN — 上传加密数据
      4. sendmessage — 发送图片消息（含 encrypt_query_param）
```

支持一轮对话发送多张图片，每张独立上传，不受 ACP bridge 单图限制。

### 接收图片（入站）

- `extractContent()` 处理用户发来的图片
- `detectImageMime()` 检测 base64 数据的真实 MIME（忽略 SDK 传入的 `mimeType`，避免 Claude API 400）

## 会话管理

- 每个微信会话在当前 bridge 进程内独立维护
- 每次 bridge/Codex 重启都会通过 ACP `session/new` 创建全新的 Codex 会话
- 不读取旧版 Claude Agent 的 `sessions.json`，不会自动恢复旧对话

### 多微信账号

重复执行 `npx weixin-acp login` 可添加多个微信账号；登录不会覆盖已有账号。启动时默认连接全部账号：

```bash
npx weixin-acp codex
```

也可以只启动指定账号：

```bash
WECHAT_ACCOUNT_ID=账号ID npx weixin-acp codex
# 或
WECHAT_ACCOUNT_IDS=账号ID1,账号ID2 npx weixin-acp codex
```

每个账号有独立的 `get_updates_buf`、context token、Codex ACP 进程和会话。服务重启后，各账号都会重新创建新会话。

### 微信端调试命令

以下命令在 bridge 层直接处理，不会调用 Codex：

```text
/status       查看账号、Codex session、ACP PID、工作目录和代理状态
/tools        查看当前工具
/clear        清除当前微信会话
/toggle-debug 开关通道耗时调试
/echo test    测试微信通道延迟
/help         查看命令帮助
```

### 查询用户输入日志

按微信用户 ID 查询最近几天的用户输入和机器人回复：

```bash
bash query-user-inputs.sh '<微信用户ID>' 3
# 也可以直接使用当前账号登记顺序的序号
bash query-user-inputs.sh 1 3
# 导出到文件（目标文件已存在时不会覆盖）
bash query-user-inputs.sh 1 7 --output user-1-session.log
# 查看 1/2/3/4 对应的账号和用户 ID
bash query-user-inputs.sh --list
```

脚本会自动关联 systemd 日志中的 `conversation` 和 Codex session，并按时间显示用户消息、机器人回复及 session ID；默认查询最近 3 天。

## 用户体验优化

- **思考状态通知**：处理中实时发送进度（"#001 调用模型中 | 5s"），通过 `sendWechatDirect` 直发微信
- **图片直发跳过 LLM**：图片已送达后跳过后续无意义的 LLM 调用，节省时间和 token
- **连续失败警告**：fetch 连续失败 2 次后在工具结果中提醒模型停止猜测 URL
- **最多 12 轮工具调用**，用完后强制生成最终回复
- **90 秒 LLM 超时**，避免单次调用阻塞过久
-->

## 自定义系统提示词

当前 Codex 模式使用 `~/.codex/config.toml` 和 Codex 自身的提示词配置；不会读取此文件。

## 运行

```bash
# 前台运行
bash start.sh

# 后台运行
bash start.sh --bg

# 查看状态
bash start.sh status

# 停止
bash start.sh stop
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `CODEX_PATH` | Codex CLI 路径，默认自动查找 `codex` |
| `CODEX_HOME` | Codex 配置/登录目录，沿用本机设置 |
| `CODEX_PROXY` | 仅 Codex 子进程使用的代理，默认 `socks5h://127.0.0.1:1080` |
| `WECHAT_ALLOW_SELF_DEBUG` | 是否允许微信请求修改/删除文件或重启服务，默认禁止；设为 `1` 才允许 |
| `WECHAT_ADMIN_USER_IDS` | 额外允许调试的微信用户 ID，多个 ID 用逗号分隔；账号绑定者默认是管理员 |

安全策略：微信端可以通过 `/status` 查看当前权限。默认允许聊天、读取和已暴露工具；涉及编辑、删除、重启、杀进程等自修改操作会在 ACP 权限层拒绝。仅在确认操作者可信、且确实需要通过微信改代码时，才在服务环境中设置 `WECHAT_ALLOW_SELF_DEBUG=1` 并重启服务。

服务每次启动/重启会按账号发送欢迎信息；通知只使用缓存的 `context_token`，不会额外消费微信消息。

### 目录结构

```
~/.openclaw/wechat-agent/
  ├── logs/
  │   ├── bridge.log     # ACP bridge 日志
  │   ├── agent.log      # Agent 结构化日志
  │   └── bridge.pid     # 进程 PID
  ├── session.json       # 会话持久化
  ├── system-prompt.md   # 自定义系统提示词
  └── wechat-account.json  # 微信账号信息（自动生成）
```
