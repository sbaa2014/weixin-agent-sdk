# wechat-agent

基于 Claude API 的微信 AI 助手，通过 ACP bridge 接入微信，支持联网搜索、代码执行、图片收发和子 Agent 委派。

## 架构

```
微信用户 ↔ 微信服务器 ↔ weixin-acp (ACP bridge) ↔ agent.mjs ↔ Claude API
                                                        ↓
                                              Puppeteer / 工具执行
```

- **weixin-acp**：长轮询收发微信消息，通过 JSON-RPC over stdio 与 agent 通信
- **agent.mjs**：核心逻辑，管理会话、调用 LLM、执行工具、发送回复
- **Claude API**：LLM 后端（claude-4.6-opus），支持多轮对话和工具调用

## 工具能力

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

- 每用户独立 session，历史保留最近 40 轮
- 持久化到 `~/.openclaw/wechat-agent/session.json`，重启自动恢复
- `sanitizeHistory()` 清理历史中不合法的消息结构

## 用户体验优化

- **思考状态通知**：处理中实时发送进度（"#001 调用模型中 | 5s"），通过 `sendWechatDirect` 直发微信
- **图片直发跳过 LLM**：图片已送达后跳过后续无意义的 LLM 调用，节省时间和 token
- **连续失败警告**：fetch 连续失败 2 次后在工具结果中提醒模型停止猜测 URL
- **最多 12 轮工具调用**，用完后强制生成最终回复
- **90 秒 LLM 超时**，避免单次调用阻塞过久

## 自定义系统提示词

在 `~/.openclaw/wechat-agent/system-prompt.md` 中写入自定义内容，会追加到内置 system prompt 后面。

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
| `ANTHROPIC_API_KEY` | Claude API Key |
| `ANTHROPIC_BASE_URL` | API 地址（可选，默认 Anthropic 官方） |
| `DEFAULT_MODEL` | 模型名称（默认 `claude-4.6-opus`） |

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
