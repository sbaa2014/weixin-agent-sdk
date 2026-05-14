#!/usr/bin/env node
/**
 * Custom ACP Agent — 兼容 weixin-acp 和 wechat-acp
 *
 * 功能:
 *   1. 多模型路由 (Claude / 其他模型)
 *   2. 内置工具: 联网搜索、代码执行、天气查询、网页抓取
 *   3. 多 Agent 编排: 根据任务类型分发给不同的子 agent
 *   4. 会话记忆: 每个 session 维护对话历史
 *   5. 本地日志: ~/wechat-agent/logs/ 带 size 轮换
 *
 * 启动方式:
 *   npx weixin-acp start -- node ./agent.mjs
 *   npx wechat-acp --agent "node ./agent.mjs"
 */

import { Readable, Writable } from "node:stream";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as acp from "@agentclientprotocol/sdk";
import Anthropic from "@anthropic-ai/sdk";

// ─── Version & Build ───────────────────────────────────────────────────────

const AGENT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PKG = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "package.json"), "utf-8"));
const AGENT_VERSION = PKG.version;
const BUILD_FILE = path.join(AGENT_DIR, ".build");
const AGENT_BUILD = (() => {
  try { return parseInt(fs.readFileSync(BUILD_FILE, "utf-8").trim(), 10) || 0; }
  catch { return 0; }
})();
const AGENT_START_TIME = new Date();

// ─── Config ────────────────────────────────────────────────────────────────

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") || undefined;
const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.ANTHROPIC_API_KEY ||
  "dummy";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

// ─── Logger ────────────────────────────────────────────────────────────────

const LOG_DIR = process.env.AGENT_LOG_DIR || path.join(os.homedir(), ".openclaw", "wechat-agent", "logs");
const LOG_MAX_FILE = 5 * 1024 * 1024;   // 单文件 5MB 触发轮换
const LOG_MAX_TOTAL = 20 * 1024 * 1024;  // 总量 20MB 上限
const LOG_FILE = path.join(LOG_DIR, "agent.log");

class Logger {
  constructor() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    this.stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  }

  _ts() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  _write(level, msg, data) {
    const line = data !== undefined
      ? `${this._ts()} [${level}] ${msg} ${JSON.stringify(data)}`
      : `${this._ts()} [${level}] ${msg}`;
    this.stream.write(line + "\n");
    this._maybeRotate();
  }

  info(msg, data)  { this._write("INFO", msg, data); }
  warn(msg, data)  { this._write("WARN", msg, data); }
  error(msg, data) { this._write("ERR", msg, data); }

  _maybeRotate() {
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size < LOG_MAX_FILE) return;
    } catch { return; }

    this.stream.end();
    const rotated = path.join(LOG_DIR, `agent.${Date.now()}.log`);
    fs.renameSync(LOG_FILE, rotated);
    this.stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    this._pruneOld();
  }

  _pruneOld() {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith(".log"))
      .map(f => ({ name: f, full: path.join(LOG_DIR, f), size: fs.statSync(path.join(LOG_DIR, f)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));

    let total = files.reduce((s, f) => s + f.size, 0);
    let i = 0;
    while (total > LOG_MAX_TOTAL && i < files.length - 1) {
      fs.unlinkSync(files[i].full);
      total -= files[i].size;
      i++;
    }
  }
}

const log = new Logger();

// ─── Tools Definition ──────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "web_search",
    description:
      "搜索互联网获取最新信息。用于回答需要实时数据的问题，如新闻、天气、股价等。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
  },
  {
    name: "run_code",
    description:
      "在沙箱中执行代码并返回结果。支持 Python、Node.js、Bash。用于计算、数据处理、验证逻辑等。",
    input_schema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["python", "nodejs", "bash"],
          description: "编程语言",
        },
        code: { type: "string", description: "要执行的代码" },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "fetch_url",
    description: "抓取指定网页的内容，返回文本摘要。用于获取网页、API 数据等。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的 URL" },
      },
      required: ["url"],
    },
  },
  {
    name: "delegate_agent",
    description:
      "将子任务委派给专门的 agent 处理。可选: coder(编程)、translator(翻译)、analyst(数据分析)。",
    input_schema: {
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          enum: ["coder", "translator", "analyst"],
          description: "子 agent 类型",
        },
        task: { type: "string", description: "要委派的任务描述" },
      },
      required: ["agent_type", "task"],
    },
  },
];

// ─── Tool Implementations ──────────────────────────────────────────────────

async function toolWebSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const html = execSync(
      `curl -sL "https://lite.duckduckgo.com/lite/?q=${encoded}" --max-time 10`,
      { encoding: "utf-8", timeout: 15000 }
    );
    const results = [];
    const linkRegex =
      /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex =
      /<td class="result-snippet">([\s\S]*?)<\/td>/gi;

    let match;
    while ((match = linkRegex.exec(html)) && results.length < 5) {
      results.push({
        url: match[1],
        title: match[2].replace(/<[^>]*>/g, "").trim(),
      });
    }
    let i = 0;
    while ((match = snippetRegex.exec(html)) && i < results.length) {
      results[i].snippet = match[1].replace(/<[^>]*>/g, "").trim();
      i++;
    }

    if (results.length === 0) {
      return `搜索 "${query}" 未找到明确结果。请尝试换个关键词。`;
    }
    return results
      .map(
        (r, idx) =>
          `${idx + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`
      )
      .join("\n\n");
  } catch (err) {
    return `搜索失败: ${err.message}`;
  }
}

function toolRunCode(language, code) {
  const commands = {
    python: ["python3", "-c"],
    nodejs: ["node", "-e"],
    bash: ["bash", "-c"],
  };
  const [cmd, flag] = commands[language] || commands.bash;
  try {
    const output = execSync(`${cmd} ${flag} ${JSON.stringify(code)}`, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH },
    });
    return output || "(无输出)";
  } catch (err) {
    return `执行出错:\n${err.stderr || err.message}`;
  }
}

async function toolFetchUrl(url) {
  try {
    const html = execSync(
      `curl -sL ${JSON.stringify(url)} --max-time 15 -H "User-Agent: Mozilla/5.0"`,
      { encoding: "utf-8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 }
    );
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const truncated = text.slice(0, 4000);
    return truncated + (text.length > 4000 ? "\n...(已截断)" : "");
  } catch (err) {
    return `抓取失败: ${err.message}`;
  }
}

// ─── Sub-Agent Prompts ─────────────────────────────────────────────────────

const SUB_AGENT_PROMPTS = {
  coder: `你是一个专业的编程助手。请用代码解决用户的问题，给出完整可运行的代码，并解释关键部分。`,
  translator: `你是一个专业的翻译助手。请准确翻译用户给出的文本，保持原文风格和语气。如未指定目标语言，中文翻译为英文，其他语言翻译为中文。`,
  analyst: `你是一个数据分析专家。请分析用户提供的数据或问题，给出清晰的结论和建议，如有需要可给出图表描述或计算过程。`,
};

async function toolDelegateAgent(client, agentType, task) {
  const systemPrompt = SUB_AGENT_PROMPTS[agentType];
  if (!systemPrompt) return `未知的 agent 类型: ${agentType}`;
  try {
    const resp = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: task }],
    });
    return resp.content.map((b) => b.text || "").join("");
  } catch (err) {
    return `子 Agent (${agentType}) 处理失败: ${err.message}`;
  }
}

// ─── Execute Tool ──────────────────────────────────────────────────────────

async function executeTool(client, name, input) {
  const t0 = Date.now();
  let result;
  try {
    switch (name) {
      case "web_search":
        result = await toolWebSearch(input.query); break;
      case "run_code":
        result = toolRunCode(input.language, input.code); break;
      case "fetch_url":
        result = await toolFetchUrl(input.url); break;
      case "delegate_agent":
        result = await toolDelegateAgent(client, input.agent_type, input.task); break;
      default:
        result = `未知工具: ${name}`;
    }
    log.info(`tool.done tool=${name} ms=${Date.now() - t0} result_len=${result.length}`);
  } catch (err) {
    result = `工具执行失败: ${err.message}`;
    log.error(`tool.fail tool=${name} ms=${Date.now() - t0}`, err.message);
  }
  return result;
}

// ─── System Prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个强大的 AI 助手，运行在微信上，名叫"小助手"。

你具备以下能力，请在合适的时候主动使用:
1. **联网搜索** (web_search) — 搜索最新信息、新闻、知识
2. **代码执行** (run_code) — 运行 Python/Node.js/Bash 代码来计算或验证
3. **网页抓取** (fetch_url) — 获取网页内容
4. **子Agent委派** (delegate_agent) — 将专业任务委派给编程/翻译/分析专家

规则:
- 用中文回复，除非用户用其他语言提问
- 回复简洁精炼，适合在微信中阅读（避免过长段落）
- 如果用户的问题需要最新信息（新闻、天气、股价等），主动使用搜索工具
- 如果用户要求计算或验证，使用代码执行
- 如果用户需要翻译或编程，可以委派给专门的子 agent
- 不确定的信息要明确说明`;

// ─── ACP Agent Class ───────────────────────────────────────────────────────

class MyAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
    this.client = new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
      baseURL: ANTHROPIC_BASE_URL,
    });
    log.info("agent.init", { model: DEFAULT_MODEL, baseURL: ANTHROPIC_BASE_URL });
  }

  async initialize(_params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession(_params) {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { history: [], pendingPrompt: null });
    log.info(`session.new id=${sessionId}`);
    return { sessionId };
  }

  async authenticate(_params) { return {}; }
  async setSessionMode(_params) { return {}; }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    const userText = this.extractText(params.prompt);
    log.info(`prompt sid=${params.sessionId.slice(0, 8)} text=${JSON.stringify(userText?.slice(0, 100))}`);

    try {
      await this.handleTurn(params.sessionId, session, params.prompt);
    } catch (err) {
      if (session.pendingPrompt?.signal.aborted) {
        log.info(`prompt.cancelled sid=${params.sessionId.slice(0, 8)}`);
        return { stopReason: "cancelled" };
      }
      log.error(`prompt.error sid=${params.sessionId.slice(0, 8)}`, err.message);
      await this.sendText(params.sessionId, `处理出错: ${err.message}`);
    }

    session.pendingPrompt = null;
    return { stopReason: "end_turn" };
  }

  async cancel(params) {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
    log.info(`prompt.cancel sid=${params.sessionId.slice(0, 8)}`);
  }

  // ─── Core Turn Logic ──────────────────────────────────────────────────

  async handleTurn(sessionId, session, promptContent) {
    const userText = this.extractText(promptContent);
    if (!userText) {
      await this.sendText(sessionId, "请发送文字消息。");
      return;
    }

    // 内置命令 — 直接返回，不经过 LLM
    const handled = await this.handleCommand(sessionId, userText);
    if (handled) return;

    session.history.push({ role: "user", content: userText });
    if (session.history.length > 40) {
      session.history = session.history.slice(-40);
    }

    let toolCallCounter = 0;
    const MAX_TOOL_ROUNDS = 8;

    while (toolCallCounter < MAX_TOOL_ROUNDS) {
      const t0 = Date.now();
      const response = await this.client.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        messages: session.history,
      });
      log.info(`llm.call ms=${Date.now() - t0} stop=${response.stop_reason} blocks=${response.content.length} usage=${JSON.stringify(response.usage)}`);

      let hasToolUse = false;
      const assistantContent = [];

      for (const block of response.content) {
        assistantContent.push(block);

        if (block.type === "text" && block.text) {
          await this.sendText(sessionId, block.text);
          log.info(`reply sid=${sessionId.slice(0, 8)} len=${block.text.length}`);
        }

        if (block.type === "tool_use") {
          hasToolUse = true;
          toolCallCounter++;
          log.info(`tool.call tool=${block.name}`, block.input);

          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: block.id,
              title: this.toolTitle(block.name, block.input),
              kind: this.toolKind(block.name),
              status: "pending",
              rawInput: block.input,
            },
          });

          const result = await executeTool(this.client, block.name, block.input);

          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: block.id,
              status: "completed",
              content: [
                { type: "content", content: { type: "text", text: result } },
              ],
              rawOutput: { result },
            },
          });

          session.history.push({ role: "assistant", content: assistantContent });
          session.history.push({
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: block.id, content: result },
            ],
          });
        }
      }

      if (!hasToolUse) {
        session.history.push({ role: "assistant", content: assistantContent });
        break;
      }
    }
  }

  // ─── Built-in Commands ─────────────────────────────────────────────────

  async handleCommand(sessionId, text) {
    const cmd = text.trim().toLowerCase();
    if (cmd === "/version" || cmd === "版本" || cmd === "/v") {
      const uptime = this.formatUptime(Date.now() - AGENT_START_TIME.getTime());
      const info = [
        `wechat-agent v${AGENT_VERSION} (build ${AGENT_BUILD})`,
        `模型: ${DEFAULT_MODEL}`,
        `Node: ${process.version}`,
        `启动: ${AGENT_START_TIME.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
        `运行: ${uptime}`,
        `会话数: ${this.sessions.size}`,
        `PID: ${process.pid}`,
      ].join("\n");
      await this.sendText(sessionId, info);
      log.info(`cmd.version sid=${sessionId.slice(0, 8)}`);
      return true;
    }
    if (cmd === "/help" || cmd === "帮助" || cmd === "/h") {
      const help = [
        "可用命令:",
        "  /version (版本) — 查看版本和运行状态",
        "  /help (帮助) — 显示此帮助",
        "",
        "直接发消息即可对话，我会自动搜索、计算、翻译。",
      ].join("\n");
      await this.sendText(sessionId, help);
      log.info(`cmd.help sid=${sessionId.slice(0, 8)}`);
      return true;
    }
    return false;
  }

  formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}天${h}小时${m}分`;
    if (h > 0) return `${h}小时${m}分`;
    return `${m}分`;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  extractText(prompt) {
    if (!prompt) return "";
    for (const item of prompt) {
      if (item.type === "text") return item.text;
      if (item.content) {
        for (const c of Array.isArray(item.content) ? item.content : [item.content]) {
          if (c.type === "text") return c.text;
        }
      }
    }
    return "";
  }

  async sendText(sessionId, text) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  toolTitle(name, input) {
    const titles = {
      web_search: `搜索: ${input.query || ""}`,
      run_code: `执行${input.language || ""}代码`,
      fetch_url: `抓取: ${input.url || ""}`,
      delegate_agent: `委派给 ${input.agent_type || ""} agent`,
    };
    return titles[name] || name;
  }

  toolKind(name) {
    const kinds = {
      web_search: "search",
      run_code: "execute",
      fetch_url: "fetch",
      delegate_agent: "other",
    };
    return kinds[name] || "other";
  }
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

log.info("agent.start", { pid: process.pid, node: process.version });

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((conn) => new MyAgent(conn), stream);
