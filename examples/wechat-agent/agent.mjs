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
import nodeCrypto from "node:crypto";
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

// Load env from ~/.claude/settings.json (same config Claude Code uses)
try {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  if (settings.env) {
    for (const [k, v] of Object.entries(settings.env)) {
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch {}

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") || undefined;
const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.ANTHROPIC_API_KEY ||
  "dummy";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

// ─── WeChat Direct Send (bypass ACP for real-time notifications) ──────────

function loadWechatAccount() {
  const dir = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json") && !f.includes(".sync"));
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (data.token && data.baseUrl && data.userId) return data;
    }
  } catch {}
  return null;
}

const WECHAT_ACCOUNT = loadWechatAccount();
let wechatContextToken = null;

// Load cached context token
try {
  const cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openclaw", "wechat-agent", "last-context.json"), "utf-8"));
  const entry = cache[WECHAT_ACCOUNT?.userId];
  if (entry?.contextToken) wechatContextToken = entry.contextToken;
} catch {}

// debug logged after Logger init below

async function sendWechatDirect(text) {
  if (!WECHAT_ACCOUNT || !wechatContextToken) {
    log.warn(`direct-send.skip account=${!!WECHAT_ACCOUNT} token=${!!wechatContextToken}`);
    return false;
  }
  const url = `${WECHAT_ACCOUNT.baseUrl.replace(/\/+$/, "")}/ilink/bot/sendmessage`;
  const uin = Buffer.from(String(nodeCrypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: WECHAT_ACCOUNT.userId,
      client_id: `notify-${nodeCrypto.randomUUID()}`,
      message_type: 2,
      message_state: 2,
      context_token: wechatContextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: "1.0.2" },
  });
  log.info(`direct-send.attempt url=${url.slice(0, 40)} len=${text.length}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "Authorization": `Bearer ${WECHAT_ACCOUNT.token}`,
        "X-WECHAT-UIN": uin,
      },
      body,
    });
    const resText = await res.text();
    log.info(`direct-send.result status=${res.status} body=${resText.slice(0, 100)}`);
    return res.ok;
  } catch (e) {
    log.error("direct-send.error", e.message);
    return false;
  }
}

// ─── WeChat Direct Image Send ─────────────────────────────────────────────

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function aesEcbEncrypt(plaintext, key) {
  const cipher = nodeCrypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function wechatApiHeaders() {
  const uin = Buffer.from(String(nodeCrypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
  return {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "Authorization": `Bearer ${WECHAT_ACCOUNT.token}`,
    "X-WECHAT-UIN": uin,
  };
}

async function sendWechatImageDirect(imageBuf, mimeType) {
  if (!WECHAT_ACCOUNT || !wechatContextToken) return false;
  const baseUrl = WECHAT_ACCOUNT.baseUrl.replace(/\/+$/, "");
  const toUserId = WECHAT_ACCOUNT.userId;

  const rawsize = imageBuf.length;
  const rawfilemd5 = nodeCrypto.createHash("md5").update(imageBuf).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = nodeCrypto.randomBytes(16).toString("hex");
  const aeskey = nodeCrypto.randomBytes(16);

  // Step 1: getUploadUrl
  const uploadResp = await fetch(`${baseUrl}/ilink/bot/getuploadurl`, {
    method: "POST",
    headers: wechatApiHeaders(),
    body: JSON.stringify({
      filekey, media_type: 1, to_user_id: toUserId,
      rawsize, rawfilemd5, filesize, no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
      base_info: { channel_version: "1.0.2" },
    }),
  });
  if (!uploadResp.ok) throw new Error(`getUploadUrl ${uploadResp.status}`);
  const uploadData = await uploadResp.json();

  // Step 2: encrypt and upload to CDN
  const ciphertext = aesEcbEncrypt(imageBuf, aeskey);
  const uploadFullUrl = uploadData.upload_full_url?.trim();
  const uploadParam = uploadData.upload_param;
  let cdnUrl;
  if (uploadFullUrl) cdnUrl = uploadFullUrl;
  else if (uploadParam) cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  else throw new Error("getUploadUrl: no upload URL returned");

  let downloadParam;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const cdnResp = await fetch(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
    });
    if (cdnResp.status >= 400 && cdnResp.status < 500) throw new Error(`CDN upload ${cdnResp.status}`);
    if (cdnResp.status === 200) {
      downloadParam = cdnResp.headers.get("x-encrypted-param");
      if (downloadParam) break;
    }
    if (attempt === 3) throw new Error(`CDN upload failed after 3 attempts`);
  }

  // Step 3: send image message
  const sendResp = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: wechatApiHeaders(),
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: `img-${nodeCrypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        context_token: wechatContextToken,
        item_list: [{
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"),
              encrypt_type: 1,
            },
            mid_size: filesize,
          },
        }],
      },
      base_info: { channel_version: "1.0.2" },
    }),
  });
  const sendText = await sendResp.text();
  return sendResp.ok;
}

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
    return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace("T", " ");
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
log.info(`direct-send.init account=${!!WECHAT_ACCOUNT} contextToken=${!!wechatContextToken}`);

// ─── Session Persistence ──────────────────────────────────────────────────

const SESSIONS_FILE = path.join(os.homedir(), ".openclaw", "wechat-agent", "sessions.json");

function stripMediaForPersist(history) {
  return (history || []).map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const stripped = msg.content.map(b => {
      if (b.type === "image") return { type: "text", text: "[图片]" };
      if (b.type === "document") return { type: "text", text: "[文档]" };
      return b;
    });
    return { ...msg, content: stripped };
  });
}

function saveSession(history, pendingText) {
  const data = {
    default: {
      history: stripMediaForPersist(sanitizeHistory((history || []).slice(-40))),
      pendingText: pendingText || null,
      updatedAt: new Date().toISOString(),
    },
  };
  const tmp = SESSIONS_FILE + ".tmp";
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, SESSIONS_FILE);
    log.info(`session.save history=${data.default.history.length} pending=${!!pendingText}`);
  } catch (err) {
    log.error("session.save.error", err.message);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    const s = raw.default;
    if (s && Array.isArray(s.history)) {
      const history = sanitizeHistory(s.history);
      log.info(`session.load history=${history.length} pending=${!!s.pendingText}`);
      return { history, pendingText: s.pendingText || null };
    }
  } catch {}
  return null;
}

function sanitizeHistory(history) {
  // Pass 1: pair tool_use with tool_result, strip broken pairs
  const paired = [];
  let i = 0;
  while (i < history.length) {
    const msg = history[i];

    if (msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some(b => b.type === "tool_use")) {
      const toolUseIds = new Set(msg.content.filter(b => b.type === "tool_use").map(b => b.id));
      const next = history[i + 1];
      // Check if next is the matching tool_result
      if (next && next.role === "user" && Array.isArray(next.content) &&
          next.content.some(b => b.type === "tool_result" && toolUseIds.has(b.tool_use_id))) {
        paired.push(msg);
        paired.push(next);
        i += 2;
      } else {
        // Strip tool_use, keep only text blocks
        const textOnly = msg.content.filter(b => b.type === "text" && b.text);
        if (textOnly.length > 0) {
          paired.push({ role: "assistant", content: textOnly });
        }
        i++;
      }
    } else if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some(b => b.type === "tool_result")) {
      // Orphan tool_result — skip
      i++;
    } else {
      paired.push(msg);
      i++;
    }
  }

  // Pass 2: build final sequence treating [assistant(tool_use), user(tool_result)] as atomic pairs
  // Collect "segments": either a tool pair (assistant+user) or a standalone message
  const segments = [];
  for (let j = 0; j < paired.length; j++) {
    const msg = paired[j];
    const isAssistantWithToolUse = msg.role === "assistant" && Array.isArray(msg.content) &&
      msg.content.some(b => b.type === "tool_use");
    if (isAssistantWithToolUse) {
      const nxt = paired[j + 1];
      const hasResult = nxt && nxt.role === "user" && Array.isArray(nxt.content) &&
        nxt.content.some(b => b.type === "tool_result");
      if (hasResult) {
        segments.push({ type: "tool_pair", assistant: msg, result: nxt });
        j++;
      } else {
        // Orphan tool_use — keep only text
        const textOnly = msg.content.filter(b => b.type === "text" && b.text);
        if (textOnly.length > 0) segments.push({ type: "msg", msg: { role: "assistant", content: textOnly } });
      }
    } else if (msg.role === "user" && Array.isArray(msg.content) && msg.content.every(b => b.type === "tool_result")) {
      // Orphan tool_result — skip
    } else {
      segments.push({ type: "msg", msg });
    }
  }

  // Flatten segments into a valid message sequence with strict alternation
  const result = [];
  for (const seg of segments) {
    if (seg.type === "tool_pair") {
      const last = result[result.length - 1];
      if (last && last.role === "assistant") continue;
      if (!last || last.role === "user") {
        result.push(seg.assistant);
        result.push(seg.result);
      }
    } else {
      const msg = seg.msg;
      const last = result[result.length - 1];
      if (!last) {
        if (msg.role === "user") result.push(msg);
        continue;
      }
      if (last.role === msg.role) {
        if (msg.role === "user") {
          // Pop tool pairs upward until we reach a non-tool-result user or a safe point
          while (result.length > 0) {
            const top = result[result.length - 1];
            if (!(top.role === "user" && Array.isArray(top.content) && top.content.some(b => b.type === "tool_result"))) break;
            result.pop(); // remove tool_result
            const assist = result[result.length - 1];
            if (assist && assist.role === "assistant" && Array.isArray(assist.content) &&
                assist.content.some(b => b.type === "tool_use")) {
              const textOnly = assist.content.filter(b => b.type === "text" && b.text);
              if (textOnly.length > 0) { assist.content = textOnly; break; }
              else { result.pop(); }
            } else { break; }
          }
          const newLast = result[result.length - 1];
          if (!newLast || newLast.role !== "user") result.push(msg);
          else result[result.length - 1] = msg;
        }
        continue;
      }
      result.push(msg);
    }
  }

  // Ensure starts with a plain user message (not tool_result)
  while (result.length) {
    const first = result[0];
    if (first.role === "user" && !(Array.isArray(first.content) && first.content.every(b => b.type === "tool_result"))) break;
    result.shift();
  }

  // Compress old tool_results: keep last 3 tool pairs full, truncate older ones to 200 chars
  const KEEP_FULL = 3;
  const TRUNCATE_LEN = 200;
  let toolPairCount = 0;
  for (let k = result.length - 1; k >= 0; k--) {
    const msg = result[k];
    if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some(b => b.type === "tool_result")) {
      toolPairCount++;
      if (toolPairCount > KEEP_FULL) {
        msg.content = msg.content.map(b => {
          if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > TRUNCATE_LEN) {
            return { ...b, content: b.content.slice(0, TRUNCATE_LEN) + "...(已压缩)" };
          }
          return b;
        });
      }
    }
  }

  return result;
}

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
    description: "抓取指定URL的内容。如果是图片URL会自动发送到微信。重要：只使用你从搜索结果或网页中获得的真实URL，绝对不要自己猜测或编造URL！",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的真实URL（必须来自搜索结果或网页，不要自己构造）" },
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

// ─── Browser Pool (max 2 concurrent, memory-limited) ─────────────────────

let puppeteer;
try { puppeteer = await import("puppeteer"); } catch { puppeteer = null; }

const BROWSER_MAX_CONCURRENT = 2;
let browserActive = 0;
const browserQueue = [];

function acquireBrowser() {
  return new Promise((resolve) => {
    if (browserActive < BROWSER_MAX_CONCURRENT) {
      browserActive++;
      resolve();
    } else {
      browserQueue.push(resolve);
    }
  });
}

function releaseBrowser() {
  if (browserQueue.length > 0) {
    browserQueue.shift()();
  } else {
    browserActive--;
  }
}

async function withBrowser(fn) {
  await acquireBrowser();
  let browser;
  try {
    browser = await puppeteer.default.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--js-flags=--max-old-space-size=128",
        "--disable-extensions",
        "--disable-background-networking",
        "--single-process",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    return await fn(browser);
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseBrowser();
  }
}

async function toolWebSearch(query) {
  if (!puppeteer) {
    return toolWebSearchFallback(query);
  }
  try {
    return await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
      const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
      await page.goto(url, { timeout: 20000, waitUntil: "networkidle2" });
      const text = await page.evaluate(() => {
        const results = [];
        const containers = document.querySelectorAll("[tpl], .result");
        for (const el of containers) {
          if (results.length >= 6) break;
          const h3 = el.querySelector("h3");
          if (!h3) continue;
          const a = h3.querySelector("a");
          const title = h3.innerText.trim();
          // 百度真实URL: 优先 mu 属性 > data-log 中的 mu > a.href
          let href = el.getAttribute("mu") || "";
          if (!href) {
            try {
              const dl = el.getAttribute("data-log");
              if (dl) { const p = JSON.parse(dl); href = p.mu || ""; }
            } catch {}
          }
          if (!href) {
            const cite = el.querySelector("a[data-is-main-url]");
            href = cite?.getAttribute("href") || a?.href || "";
          }
          const allText = el.innerText;
          const snippet = allText.replace(title, "").trim().split("\n").filter(l => l.length > 10).slice(0, 2).join(" ").slice(0, 150);
          if (title) results.push({ title, url: href, snippet });
        }
        return results;
      });
      if (text.length === 0) {
        const bodyText = await page.evaluate(() => document.body.innerText);
        return `百度搜索 "${query}" 结果:\n\n${bodyText.slice(0, 2000)}`;
      }
      // 解析残留的百度跳转链接
      for (const r of text) {
        if (r.url && r.url.includes("baidu.com/link")) {
          try {
            const resp = await fetch(r.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(5000) });
            if (resp.url && !resp.url.includes("baidu.com")) r.url = resp.url;
          } catch {}
        }
      }
      return text
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
    });
  } catch (err) {
    log.warn(`search.browser.fail query=${query}`, err.message);
    return toolWebSearchFallback(query);
  }
}

function toolWebSearchFallback(query) {
  try {
    const encoded = encodeURIComponent(query);
    const html = execSync(
      `curl -sL "https://lite.duckduckgo.com/lite/?q=${encoded}" --max-time 10`,
      { encoding: "utf-8", timeout: 15000 }
    );
    const results = [];
    const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<td class="result-snippet">([\s\S]*?)<\/td>/gi;
    let match;
    while ((match = linkRegex.exec(html)) && results.length < 5) {
      results.push({ url: match[1], title: match[2].replace(/<[^>]*>/g, "").trim() });
    }
    let i = 0;
    while ((match = snippetRegex.exec(html)) && i < results.length) {
      results[i].snippet = match[1].replace(/<[^>]*>/g, "").trim();
      i++;
    }
    if (results.length === 0) return `搜索 "${query}" 未找到结果。`;
    return results.map((r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`).join("\n\n");
  } catch (err) {
    return `搜索失败: ${err.message}`;
  }
}

function toolRunCode(language, code) {
  const exts = { python: ".py", nodejs: ".mjs", bash: ".sh" };
  const cmds = { python: "python3", nodejs: "node", bash: "bash" };
  const ext = exts[language] || ".sh";
  const cmd = cmds[language] || "bash";
  const tmpFile = path.join(os.tmpdir(), `agent-run-${Date.now()}${ext}`);
  try {
    fs.writeFileSync(tmpFile, code, "utf-8");
    const output = execSync(`${cmd} ${JSON.stringify(tmpFile)}`, {
      encoding: "utf-8",
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: process.env.PATH },
    });
    return output || "(无输出)";
  } catch (err) {
    return `执行出错:\n${err.stderr || err.message}`;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i;

function validateImage(buf) {
  if (!buf || buf.length < 100) return null;
  if (buf[0] === 0x3C) return null; // HTML page (<html>, <!DOCTYPE, etc.)
  const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isGif = buf[0] === 0x47 && buf[1] === 0x49;
  const isWebp = buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  if (!isJpeg && !isPng && !isGif && !isWebp) return null;
  const ext = isJpeg ? "jpeg" : isPng ? "png" : isGif ? "gif" : "webp";
  return { base64: buf.toString("base64"), mimeType: `image/${ext}` };
}

// 通用浏览器下载：用 CDP Fetch 拦截获取原始字节
// 返回 { imageBuf } 如果响应是图片，{ html } 如果是网页，null 如果失败
// expectImage=true 时，非图片响应直接返回 null
async function browserFetch(url, { expectImage = false } = {}) {
  if (!puppeteer) return null;
  try {
    return await Promise.race([
      withBrowser(async (browser) => {
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36");
        const client = await page.createCDPSession();
        await client.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
        let firstStatus = 0;
        const bodyPromise = new Promise((resolve) => {
          client.on("Fetch.requestPaused", async (evt) => {
            try {
              const status = evt.responseStatusCode || 0;
              const ct = (evt.responseHeaders || []).find(h => h.name.toLowerCase() === "content-type")?.value || "";
              if (status >= 400 && !firstStatus) {
                firstStatus = status;
                await client.send("Fetch.continueResponse", { requestId: evt.requestId });
                // Don't resolve yet — let Cloudflare JS challenge redirect
                return;
              }
              if (status >= 400 && firstStatus) {
                // Second 4xx+ means it's a real error, not a challenge
                await client.send("Fetch.continueResponse", { requestId: evt.requestId });
                resolve({ error: `http${status}` });
                return;
              }
              if (ct.startsWith("image/")) {
                const { body, base64Encoded } = await client.send("Fetch.getResponseBody", { requestId: evt.requestId });
                await client.send("Fetch.continueResponse", { requestId: evt.requestId });
                const buf = base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body, "binary");
                resolve({ imageBuf: buf });
                return;
              }
              if (expectImage) {
                await client.send("Fetch.continueResponse", { requestId: evt.requestId });
                resolve({ error: `not-image ct=${ct}` });
                return;
              }
              await client.send("Fetch.continueResponse", { requestId: evt.requestId });
              resolve({ isHtml: true });
            } catch (e) {
              try { await client.send("Fetch.continueResponse", { requestId: evt.requestId }); } catch {}
              resolve({ error: e.message });
            }
          });
        });
        const waitUntil = expectImage ? "load" : "networkidle2";
        page.goto(url, { timeout: 20000, waitUntil }).catch(() => {});
        const result = await Promise.race([bodyPromise, new Promise((_, rej) => setTimeout(() => rej(new Error("cdp timeout")), 22000))]);
        await client.detach();
        // If CDP resolved with error but page may have loaded via JS redirect, check page content
        if (result.error && firstStatus === 403 && !expectImage) {
          try { await page.waitForNetworkIdle({ timeout: 8000 }); } catch {}
          const finalUrl = page.url();
          const html = await page.content();
          if (html.length > 2000 && !html.includes("Just a moment") && !html.includes("Checking your browser")) {
            log.info(`browser.fetch.cf-bypass url=${finalUrl.slice(0, 60)} len=${html.length}`);
            return { html };
          }
          log.warn(`browser.fetch.fail http${firstStatus} url=${url.slice(0, 80)}`);
          return null;
        }
        if (result.error) {
          log.warn(`browser.fetch.fail ${result.error} url=${url.slice(0, 80)}`);
          return null;
        }
        if (result.imageBuf) {
          log.info(`browser.fetch.image url=${url.slice(0, 60)} size=${result.imageBuf.length}`);
          return { imageBuf: result.imageBuf };
        }
        if (result.isHtml) {
          try { await page.waitForNetworkIdle({ timeout: 5000 }); } catch {}
          const html = await page.content();
          log.info(`browser.fetch.html url=${url.slice(0, 60)} len=${html.length}`);
          return { html };
        }
        return null;
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("browser timeout 30s")), 30000)),
    ]);
  } catch (e) { log.error("browser.fetch.error", e.message); return null; }
}

let consecutiveFetchFails = 0;

// 图片验证 + 发送到微信（通用流程，供所有路径共用）
async function sendImageToWechat(buf, url, sessionId, connection) {
  log.info(`img.download size=${buf.length} first=${buf[0]},${buf[1]}`);
  const validated = validateImage(buf);
  if (!validated) {
    const head = buf.slice(0, 20).toString("utf-8").replace(/[^\x20-\x7e]/g, ".");
    return `图片下载失败: 返回内容不是有效图片 (${buf.length} bytes, head="${head}")`;
  }
  // 优先直发微信
  try {
    const sent = await sendWechatImageDirect(buf, validated.mimeType);
    if (sent) {
      consecutiveFetchFails = 0;
      log.info(`img.direct.ok url=${url.slice(0, 60)} size=${buf.length}`);
      return `[已发送图片到微信] ${url} (${Math.round(buf.length / 1024)}KB)`;
    }
  } catch (e) {
    log.error(`img.direct.fail url=${url.slice(0, 60)}`, e.message);
  }
  // fallback: ACP bridge
  if (sessionId && connection) {
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: validated.base64, mimeType: validated.mimeType } },
    });
    return `[已发送图片到微信] ${url} (${Math.round(buf.length / 1024)}KB)`;
  }
  return `[图片] ${url} (${Math.round(buf.length / 1024)}KB, 无法发送)`;
}

async function toolFetchUrl(url, sessionId, connection) {
  // ── 统一下载：browserFetch 自动区分图片/网页 ──
  const expectImage = IMAGE_EXTS.test(url);
  const result = await browserFetch(url, { expectImage });

  // 拿到图片数据 → 发送到微信
  if (result?.imageBuf) {
    return await sendImageToWechat(result.imageBuf, url, sessionId, connection);
  }

  // 显式图片 URL 但浏览器下载失败 → curl fallback
  if (expectImage && !result?.html) {
    try {
      log.info(`img.curl.fallback url=${url.slice(0, 80)}`);
      const referer = new URL(url).origin + "/";
      const buf = execSync(
        `curl -sL --fail ${JSON.stringify(url)} --max-time 15 -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0" -H "Referer: ${referer}"`,
        { timeout: 20000, maxBuffer: 5 * 1024 * 1024 }
      );
      return await sendImageToWechat(buf, url, sessionId, connection);
    } catch (err) {
      log.error(`img.curl.error url=${url.slice(0, 80)}`, err.message);
      return `图片下载失败: ${err.message}`;
    }
  }

  // ── 网页处理路径 ──
  let html = result?.html || null;
  if (!html) {
    try {
      html = execSync(
        `curl -sL ${JSON.stringify(url)} --max-time 15 -H "User-Agent: Mozilla/5.0"`,
        { encoding: "utf-8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 }
      );
    } catch (err) {
      return `抓取失败: ${err.message}`;
    }
  }
  if (!html) {
    consecutiveFetchFails++;
    let msg = `抓取失败: 页面返回错误 (404/5xx)，URL 可能不存在`;
    if (consecutiveFetchFails >= 2) msg += `\n\n⚠️ 已连续 ${consecutiveFetchFails} 次抓取失败。请停止猜测URL！只使用搜索结果中返回的真实链接，或者换一个搜索词重新搜索。`;
    return msg;
  }
  try {
    const imgUrls = [];
    const imgRegex = /<img[^>]+(?:data-src|data-original|src)=["']([^"']+)["'][^>]*/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(html)) && imgUrls.length < 20) {
      let src = imgMatch[1];
      if (src.startsWith("data:")) continue;
      if (src.startsWith("//")) src = "https:" + src;
      else if (!src.startsWith("http")) src = new URL(src, url).href;
      if (/\.(jpg|jpeg|png|gif|webp)\b/i.test(src) && !/(icon|logo|avatar|sprite|loading|pixel|1x1|favicon|share|facebook|twitter|linkedin|weibo|weixin|wechat|qrcode|btn|button|arrow|close|search|menu|nav|banner_ad|advert|\/static\/|\/common\/|image_e\/)/i.test(src)) {
        imgUrls.push(src);
      }
    }
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 50) {
      consecutiveFetchFails++;
      let msg = `页面无有效内容 (${text.length}字符)，URL 可能不存在或需要登录`;
      if (consecutiveFetchFails >= 2) msg += `\n\n⚠️ 已连续 ${consecutiveFetchFails} 次抓取失败。请停止猜测URL！只使用搜索结果中返回的真实链接。`;
      return msg;
    }
    consecutiveFetchFails = 0;
    let result = text.slice(0, 3000);
    if (text.length > 3000) result += "\n...(已截断)";
    if (imgUrls.length > 0) {
      result += "\n\n[页面图片（可直接用 fetch_url 下载发送）]:\n" + imgUrls.map((u, i) => `${i + 1}. ${u}`).join("\n");
      result += "\n\n⚠️ 请直接用上面的完整URL调用 fetch_url 下载图片，不要自己构造URL。";
    }
    return result;
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
    }, { timeout: 90_000 });
    return resp.content.map((b) => b.text || "").join("");
  } catch (err) {
    return `子 Agent (${agentType}) 处理失败: ${err.message}`;
  }
}

// ─── Execute Tool ──────────────────────────────────────────────────────────

async function executeTool(client, name, input, sessionId, connection) {
  const t0 = Date.now();
  let result;
  try {
    switch (name) {
      case "web_search":
        result = await toolWebSearch(input.query); break;
      case "run_code":
        result = toolRunCode(input.language, input.code); break;
      case "fetch_url":
        result = await toolFetchUrl(input.url, sessionId, connection); break;
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

const SYSTEM_PROMPT_BASE = `你是一个强大的 AI 助手，运行在微信上，名叫"小助手"。

你具备以下能力，请在合适的时候主动使用:
1. **联网搜索** (web_search) — 搜索最新信息、新闻、知识
2. **代码执行** (run_code) — 运行 Python/Node.js/Bash 代码来计算或验证
3. **网页抓取/发图片** (fetch_url) — 获取网页内容；如果 URL 是图片（.jpg/.png/.gif/.webp），会自动下载并发送到微信聊天中
4. **子Agent委派** (delegate_agent) — 将专业任务委派给编程/翻译/分析专家

重要：你可以发送图片！当你找到图片 URL 时，直接用 fetch_url 工具抓取该图片 URL，系统会自动将图片发送到微信。不要说"无法发送图片"。
图片搜索技巧：
- 绝对不要自己编造/猜测图片URL！只使用你从网页中实际看到的URL
- 先用 fetch_url 打开一个图片索引页（如 unsplash.com 搜索页），从返回结果中找到真实图片URL，再用 fetch_url 下载那个图片URL
- 优先用 unsplash.com、pexels.com 等开放图源搜索
- 避免 gov.cn、www.news.cn 等有防盗链的国内站点，它们的图片 URL 会返回 HTML 而非图片
- 如果一个图片 URL 下载失败，不要反复尝试同一个域名的其他路径，换个图源
- 当 fetch_url 返回的结果中包含"[页面图片]"列表时，直接用列表中的URL下载，不要构造新URL

规则:
- 用中文回复，除非用户用其他语言提问
- 回复简洁精炼，适合在微信中阅读（避免过长段落）
- 如果用户的问题需要最新信息（新闻、天气、股价等），主动使用搜索工具
- 如果用户要求计算或验证，使用代码执行
- 如果用户需要翻译或编程，可以委派给专门的子 agent
- 不确定的信息要明确说明
- 搜索效率：尽量在 3-5 次搜索内收集足够信息就开始回答。如果前几次搜索已经有相关结果，不要反复换关键词重复搜索，直接基于已有信息回答即可。信息不完整时也应给出部分回答并说明局限`;

const CUSTOM_PROMPT_FILE = path.join(os.homedir(), ".openclaw", "wechat-agent", "system-prompt.md");

function loadSystemPrompt() {
  let prompt = SYSTEM_PROMPT_BASE;
  try {
    const custom = fs.readFileSync(CUSTOM_PROMPT_FILE, "utf-8").trim();
    if (custom) {
      prompt += "\n\n" + custom;
      log.info(`system-prompt.loaded len=${custom.length}`);
    }
  } catch {}
  return prompt;
}

const SYSTEM_PROMPT = loadSystemPrompt();

// ─── Image MIME Detection ─────────────────────────────────────────────────

function detectImageMime(base64Data) {
  const head = base64Data.slice(0, 16);
  const bytes = Buffer.from(head, "base64");
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "image/jpeg";
}

// ─── ACP Agent Class ───────────────────────────────────────────────────────

class MyAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
    this.savedState = loadSession();
    this.client = new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
      baseURL: ANTHROPIC_BASE_URL,
    });
    log.info("agent.init", { model: DEFAULT_MODEL, baseURL: ANTHROPIC_BASE_URL });
  }

  async initialize(_params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true },
      },
    };
  }

  async newSession(_params) {
    const sessionId = crypto.randomUUID();
    const session = { history: [], pendingPrompt: null, resumeText: null };

    if (this.savedState) {
      session.history = this.savedState.history || [];
      session.resumeText = this.savedState.pendingText || null;
      log.info(`session.restore id=${sessionId} history=${session.history.length} resume=${!!session.resumeText}`);
      this.savedState = null;
    }

    this.sessions.set(sessionId, session);
    log.info(`session.new id=${sessionId} params=${JSON.stringify(_params).slice(0, 200)}`);
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
    const hasImage = params.prompt?.some(b => b.type === "image");
    log.info(`prompt sid=${params.sessionId.slice(0, 8)} text=${JSON.stringify(userText?.slice(0, 100))} hasImage=${hasImage}`);
    log.info(`prompt.params keys=${JSON.stringify(Object.keys(params))}`);

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
    const userContent = this.extractContent(promptContent);
    const userText = this.extractText(promptContent);

    if (!userContent) {
      await this.sendText(sessionId, "请发送文字或图片消息。");
      return;
    }

    // 内置命令 — 纯文字且以 / 或中文命令开头时检查
    if (userText) {
      const handled = await this.handleCommand(sessionId, userText);
      if (handled) return;
    }

    // Clean up interrupted turn remnants before pushing new user message
    while (session.history.length > 0 && session.history[session.history.length - 1].role === "user") {
      session.history.pop();
    }
    // If last assistant msg has tool_use (now orphaned), strip tool_use keeping only text
    const lastMsg = session.history[session.history.length - 1];
    if (lastMsg && lastMsg.role === "assistant" && Array.isArray(lastMsg.content) && lastMsg.content.some(b => b.type === "tool_use")) {
      const textOnly = lastMsg.content.filter(b => b.type === "text" && b.text);
      if (textOnly.length > 0) {
        lastMsg.content = textOnly;
      } else {
        session.history.pop();
      }
    }

    const hasMedia = userContent.some(b => b.type === "image" || b.type === "document");
    if (hasMedia) {
      const hasText = userContent.some(b => b.type === "text");
      const defaultPrompt = userContent.some(b => b.type === "document")
        ? "请分析这个文档" : "请描述这张图片";
      const content = hasText ? userContent : [...userContent, { type: "text", text: defaultPrompt }];
      session.history.push({ role: "user", content });
    } else {
      session.history.push({ role: "user", content: userText || userContent });
    }
    if (session.history.length > 40) {
      session.history = sanitizeHistory(session.history.slice(-40));
    }

    saveSession(session.history, userText);

    let toolCallCounter = 0;
    const MAX_TOOL_ROUNDS = 8;
    let turnSucceeded = false;
    let turnTokensIn = 0, turnTokensOut = 0, turnLLMCalls = 0;

    // 任务编号
    if (!session._taskSeq) session._taskSeq = 0;
    session._taskSeq++;
    const taskId = `#${String(session._taskSeq).padStart(3, "0")}`;
    let lastReplyText = null;
    let imageSentDirect = false;
    let imagesSentCount = 0;
    const fetchLog = [];
    consecutiveFetchFails = 0;

    // 思考状态追踪
    const thinkState = { phase: "思考中", tool: null, toolDetail: null, round: 0, errors: [], done: false };
    const THINK_INTERVAL = 60 * 1000;
    const thinkStart = Date.now();
    const sendProgress = async () => {
      if (thinkState.done) return;
      const elapsed = Math.round((Date.now() - thinkStart) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const timeStr = min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
      const parts = [`[${taskId}] 处理中 | ${timeStr}`];
      if (thinkState.tool) {
        parts.push(`🔧 ${thinkState.tool}${thinkState.toolDetail ? `: ${thinkState.toolDetail}` : ""}`);
      } else {
        parts.push(`💭 ${thinkState.phase}`);
      }
      if (thinkState.errors.length > 0) {
        parts.push(`⚠️ ${thinkState.errors.length} 个错误:`);
        for (const e of thinkState.errors) parts.push(`  · ${e}`);
      }
      try {
        const sent = await sendWechatDirect(parts.join("\n"));
        log.info(`think.notify ${taskId} sid=${sessionId.slice(0, 8)} elapsed=${elapsed}s phase=${thinkState.phase} direct=${sent}`);
      } catch (e) {
        log.error("think.notify.error", e.message);
      }
    };
    // 立即发第一次，之后每60秒
    sendProgress();
    const thinkFirstTimer = null;
    const thinkTimer = setInterval(sendProgress, THINK_INTERVAL);

    try {
    while (toolCallCounter < MAX_TOOL_ROUNDS) {
      thinkState.phase = "调用模型中";
      thinkState.tool = null;

      const t0 = Date.now();
      let response;
      try {
        const safeMessages = sanitizeHistory(session.history);
        response = await this.client.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: TOOL_DEFINITIONS,
          messages: safeMessages,
        }, { timeout: 90_000 });
      } catch (llmErr) {
        thinkState.errors.push(`模型调用失败: ${llmErr.message}`);
        throw llmErr;
      }
      log.info(`llm.call ms=${Date.now() - t0} stop=${response.stop_reason} blocks=${response.content.length} usage=${JSON.stringify(response.usage)}`);
      if (response.usage) {
        turnTokensIn += response.usage.input_tokens || 0;
        turnTokensOut += response.usage.output_tokens || 0;
        turnLLMCalls++;
      }

      let hasToolUse = false;
      const toolResults = [];

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          if (imageSentDirect && response.stop_reason === "end_turn") {
            log.info(`reply.skip.image-sent sid=${sessionId.slice(0, 8)} len=${block.text.length}`);
          } else {
            await this.sendText(sessionId, block.text);
            log.info(`reply sid=${sessionId.slice(0, 8)} len=${block.text.length}`);
          }
          lastReplyText = block.text;
        }

        if (block.type === "tool_use") {
          hasToolUse = true;
          toolCallCounter++;
          thinkState.round = toolCallCounter;
          thinkState.tool = block.name;
          thinkState.toolDetail = this.toolProgressDetail(block.name, block.input);
          thinkState.phase = `执行工具 ${block.name}`;
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

          let result;
          try {
            result = await executeTool(this.client, block.name, block.input, sessionId, this.connection);
          } catch (toolErr) {
            result = `工具执行出错: ${toolErr.message}`;
            thinkState.errors.push(`${block.name}: ${toolErr.message}`);
            log.error(`tool.error tool=${block.name}`, toolErr.message);
          }

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

          if (typeof result === "string" && result.includes("[已发送图片到微信]")) {
            imageSentDirect = true;
            imagesSentCount++;
          }
          if (block.name === "fetch_url" && block.input?.url) {
            const u = block.input.url;
            let host; try { host = new URL(u).hostname; } catch { host = u.slice(0, 30); }
            if (typeof result === "string" && result.includes("[已发送图片到微信]")) {
              fetchLog.push({ host, ok: true, type: "image" });
            } else if (typeof result === "string" && (result.includes("失败") || result.includes("不存在") || result.includes("不是有效图片"))) {
              fetchLog.push({ host, ok: false, reason: result.slice(0, 40) });
            } else {
              fetchLog.push({ host, ok: true, type: "page" });
            }
          }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }

      if (!hasToolUse) {
        session.history.push({ role: "assistant", content: response.content });
        break;
      }

      // Push assistant + tool results together (atomic, avoid orphan tool_use)
      session.history.push({ role: "assistant", content: response.content });
      session.history.push({ role: "user", content: toolResults });

      if (imageSentDirect && toolResults.length === 1) {
        log.info("tool.loop.break image already sent, skipping next LLM call");
        break;
      }
    }

    // If we exhausted tool rounds without a final text reply, force one without tools
    const lastHistMsg = session.history[session.history.length - 1];
    const needsFinal = lastHistMsg && lastHistMsg.role === "user" && Array.isArray(lastHistMsg.content) &&
        lastHistMsg.content.some(b => b.type === "tool_result");
    log.info(`reply.final.check needsFinal=${needsFinal} lastRole=${lastHistMsg?.role} histLen=${session.history.length}`);
    if (needsFinal) {
      thinkState.phase = "生成总结";
      const safeMessages = sanitizeHistory(session.history);
      safeMessages.push({ role: "user", content: "请根据以上搜索和抓取到的信息，直接用中文给出完整回答。即使信息不完整，也要基于已有内容尽力回答，不要留空。" });
      log.info(`reply.final.call safeLen=${safeMessages.length}`);
      const finalSystemPrompt = SYSTEM_PROMPT + "\n\n【重要】现在你必须根据前面工具调用获得的信息，生成一段对用户有帮助的中文回复。禁止返回空内容。如果信息不足以完整回答，就基于已有信息给出部分回答并说明哪些信息暂时找不到。";
      const finalResp = await this.client.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 2048,
        system: finalSystemPrompt,
        messages: safeMessages,
      }, { timeout: 90_000 });
      log.info(`reply.final.done blocks=${finalResp.content.length} stop=${finalResp.stop_reason}`);
      if (finalResp.usage) {
        turnTokensIn += finalResp.usage.input_tokens || 0;
        turnTokensOut += finalResp.usage.output_tokens || 0;
        turnLLMCalls++;
      }
      let hasFinalText = false;
      for (const block of finalResp.content) {
        if (block.type === "text" && block.text) {
          await this.sendText(sessionId, block.text);
          lastReplyText = block.text;
          log.info(`reply.final sid=${sessionId.slice(0, 8)} len=${block.text.length}`);
          hasFinalText = true;
        }
      }
      if (!hasFinalText) {
        let fallback;
        if (imageSentDirect) {
          fallback = `以上是为你找到的 ${imagesSentCount} 张图片。`;
        } else {
          fallback = "抱歉，尝试了多种方式但未能完成任务，请换个方式描述或稍后再试。";
        }
        if (fetchLog.length > 0) {
          const okList = fetchLog.filter(f => f.ok);
          const failList = fetchLog.filter(f => !f.ok);
          const parts = [];
          if (okList.length > 0) {
            const imgOk = okList.filter(f => f.type === "image");
            const pageOk = okList.filter(f => f.type === "page");
            if (imgOk.length > 0) parts.push(`成功下载 ${imgOk.length} 张图片（${[...new Set(imgOk.map(f => f.host))].join("、")}）`);
            if (pageOk.length > 0) parts.push(`浏览了 ${pageOk.length} 个网页（${[...new Set(pageOk.map(f => f.host))].join("、")}）`);
          }
          if (failList.length > 0) parts.push(`${failList.length} 个链接失败（${[...new Set(failList.map(f => f.host))].join("、")}）`);
          if (parts.length > 0) fallback += "\n" + parts.join("；");
        }
        await this.sendText(sessionId, fallback);
        lastReplyText = fallback;
        log.info(`reply.final.fallback sid=${sessionId.slice(0, 8)} imageSent=${imagesSentCount}`);
        finalResp.content = [{ type: "text", text: fallback }];
      }
      session.history.push({ role: "assistant", content: finalResp.content });
    }

    turnSucceeded = true;
    } finally {
      thinkState.done = true;
      clearTimeout(thinkFirstTimer);
      clearInterval(thinkTimer);
      // Clean up orphan: if last msg is assistant with tool_use but no following tool_result
      const last = session.history[session.history.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.content) && last.content.some(b => b.type === "tool_use")) {
        session.history.pop();
      }
      saveSession(session.history, turnSucceeded ? null : userText);
      const elapsed = Math.round((Date.now() - thinkStart) / 1000);
      if (turnSucceeded) {
        const timeStr = elapsed >= 60 ? `${Math.floor(elapsed/60)}分${elapsed%60}秒` : `${elapsed}秒`;
        const tokenStr = turnTokensIn > 0 ? ` | ${((turnTokensIn + turnTokensOut) / 1000).toFixed(1)}k tokens` : "";
        const tag = `\n${taskId} 完成 | ${timeStr}${tokenStr}`;
        await this.sendText(sessionId, tag).catch(() => {});
      }
    }
  }

  // ─── Built-in Commands ─────────────────────────────────────────────────

  async handleCommand(sessionId, text) {
    const cmd = text.trim().toLowerCase();
    const sid = sessionId.slice(0, 8);

    if (cmd === "继续" || cmd === "/resume") {
      const session = this.sessions.get(sessionId);
      if (session?.resumeText) {
        const resumeText = session.resumeText;
        session.resumeText = null;
        await this.sendText(sessionId, `正在继续处理: ${resumeText.slice(0, 50)}${resumeText.length > 50 ? "..." : ""}`);
        log.info(`cmd.resume sid=${sid} text=${JSON.stringify(resumeText.slice(0, 100))}`);
        await this.handleTurn(sessionId, session, [{ type: "text", text: resumeText }]);
      } else {
        await this.sendText(sessionId, "没有未完成的任务");
      }
      return true;
    }

    if (cmd === "/version" || cmd === "版本" || cmd === "/v") {
      const uptime = this.formatUptime(Date.now() - AGENT_START_TIME.getTime());
      const info = [
        `wechat-agent v${AGENT_VERSION} (build ${AGENT_BUILD})`,
        `模型: ${DEFAULT_MODEL}`,
        `Node: ${process.version}`,
        `启动: ${AGENT_START_TIME.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
        `运行: ${uptime}`,
        `PID: ${process.pid}`,
      ].join("\n");
      await this.sendText(sessionId, info);
      log.info(`cmd.version sid=${sid}`);
      return true;
    }

    if (cmd === "/status" || cmd === "状态") {
      const session = this.sessions.get(sessionId);
      const uptime = this.formatUptime(Date.now() - AGENT_START_TIME.getTime());
      const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const info = [
        `运行状态:`,
        `  运行时长: ${uptime}`,
        `  内存占用: ${mem}MB`,
        `  活跃会话: ${this.sessions.size}`,
        `  本轮对话: ${session ? Math.floor(session.history.length / 2) : 0} 轮`,
        `  历史条数: ${session ? session.history.length : 0}`,
      ].join("\n");
      await this.sendText(sessionId, info);
      log.info(`cmd.status sid=${sid}`);
      return true;
    }

    if (cmd === "/tools" || cmd === "工具") {
      const list = TOOL_DEFINITIONS.map(
        (t, i) => `${i + 1}. ${t.name}\n   ${t.description}`
      ).join("\n");
      await this.sendText(sessionId, `可用工具:\n${list}`);
      log.info(`cmd.tools sid=${sid}`);
      return true;
    }

    if (cmd === "/clear" || cmd === "清空" || cmd === "重置") {
      const session = this.sessions.get(sessionId);
      if (session) {
        const count = session.history.length;
        session.history = [];
        session.resumeText = null;
        saveSession([], null);
        await this.sendText(sessionId, `已清空对话记录 (${count} 条)`);
        log.info(`cmd.clear sid=${sid} cleared=${count}`);
      }
      return true;
    }

    if (cmd === "/usage" || cmd === "用量") {
      const lines = [];
      try {
        const logFile = path.join(LOG_DIR, "agent.log");
        const content = fs.readFileSync(logFile, "utf-8");
        const today = new Date().toISOString().slice(0, 10);
        let totalIn = 0, totalOut = 0, calls = 0;
        for (const line of content.split("\n")) {
          if (!line.startsWith(today)) continue;
          const m = line.match(/usage=(\{.+\})\s*$/);
          if (m) {
            calls++;
            try {
              const u = JSON.parse(m[1]);
              totalIn += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
              totalOut += u.output_tokens || 0;
            } catch {}
          }
        }
        lines.push(`今日 Token 用量:`);
        lines.push(`  LLM 调用: ${calls} 次`);
        lines.push(`  输入: ${totalIn.toLocaleString()} tokens`);
        lines.push(`  输出: ${totalOut.toLocaleString()} tokens`);
        lines.push(`  合计: ${(totalIn + totalOut).toLocaleString()} tokens`);
      } catch {
        lines.push("暂无用量数据");
      }
      await this.sendText(sessionId, lines.join("\n"));
      log.info(`cmd.usage sid=${sid}`);
      return true;
    }

    if (cmd === "/help" || cmd === "帮助" || cmd === "/h") {
      const help = [
        "可用命令:",
        "  /v (版本) — 版本和构建信息",
        "  /status (状态) — 运行状态和资源",
        "  /tools (工具) — 查看可用工具列表",
        "  /usage (用量) — 今日 Token 消耗",
        "  /clear (清空) — 清除当前对话记录",
        "  /resume (继续) — 继续上次未完成的任务",
        "  /help (帮助) — 显示此帮助",
        "",
        "直接发消息即可对话，支持搜索、计算、翻译、编程。",
      ].join("\n");
      await this.sendText(sessionId, help);
      log.info(`cmd.help sid=${sid}`);
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

  extractContent(prompt) {
    if (!prompt) return null;
    const blocks = [];
    for (const item of prompt) {
      if (item.type === "text" && item.text) {
        blocks.push({ type: "text", text: item.text });
      } else if (item.type === "image" && item.data) {
        const mime = detectImageMime(item.data);
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mime, data: item.data },
        });
      } else if (item.type === "resource" && item.resource) {
        const res = item.resource;
        const mime = res.mimeType || "application/octet-stream";
        const data = res.blob || res.text;
        if (!data) continue;
        if (mime === "application/pdf") {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: mime, data },
          });
        } else if (mime.startsWith("text/") || mime === "application/json") {
          const text = res.text || Buffer.from(data, "base64").toString("utf-8");
          const name = res.uri?.split("/").pop() || "file";
          blocks.push({ type: "text", text: `[文件: ${name}]\n${text}` });
        } else {
          const name = res.uri?.split("/").pop() || "file";
          blocks.push({ type: "text", text: `[收到文件: ${name} (${mime})，暂不支持此格式的内容解析]` });
        }
      }
    }
    return blocks.length > 0 ? blocks : null;
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

  toolProgressDetail(name, input) {
    switch (name) {
      case "web_search": return input.query || "";
      case "fetch_url": return input.url?.slice(0, 60) || "";
      case "run_code": return `${input.language || "code"}`;
      case "delegate_agent": return `${input.agent_type || ""}: ${(input.task || "").slice(0, 40)}`;
      default: return "";
    }
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
