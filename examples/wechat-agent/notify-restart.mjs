#!/usr/bin/env node
/**
 * 启动后向上次活跃用户推送重启通知
 *
 * 获取 context_token 顺序:
 *   1. 做一次短超时 getUpdates 拿最新 context_token
 *   2. 回退到 ~/.openclaw/wechat-agent/last-context.json (缓存)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const HOME = os.homedir();
const AGENT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PKG = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "package.json"), "utf-8"));
const BUILD = (() => {
  try {
    const files = fs.readdirSync(AGENT_DIR).filter(f => f.endsWith(".mjs") || f.endsWith(".sh"));
    const latest = Math.max(...files.map(f => fs.statSync(path.join(AGENT_DIR, f)).mtimeMs));
    const d = new Date(latest);
    return `${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}`;
  } catch { return "?"; }
})();

const CONTEXT_CACHE = path.join(HOME, ".openclaw", "wechat-agent", "last-context.json");

function randomUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}

// ─── getUpdates: 短超时拉一次，获取 context_token ────────────────────────────

async function fetchContextToken(baseUrl, token, getUpdatesBuf) {
  const url = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/getupdates`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "Authorization": `Bearer ${token}`,
        "X-WECHAT-UIN": randomUin(),
      },
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf || "",
        base_info: { channel_version: "1.0.2" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    // 从最后一条消息取 context_token
    const msgs = data.msgs || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].context_token) return msgs[i].context_token;
    }
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── 发送文本消息 ─────────────────────────────────────────────────────────────

async function sendText(baseUrl, token, userId, contextToken, text) {
  const url = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/sendmessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "Authorization": `Bearer ${token}`,
      "X-WECHAT-UIN": randomUin(),
    },
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: userId,
        client_id: `notify-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: "1.0.2" },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── 找 account 信息 ───────────────────────────────────────────────────────

function findAccount() {
  const dir = path.join(HOME, ".openclaw", "openclaw-weixin", "accounts");
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json") && !f.includes(".sync"));
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (data.token && data.baseUrl && data.userId) return data;
    }
  } catch {}
  return null;
}

// ─── 找 get_updates_buf ───────────────────────────────────────────────────────

function findSyncBuf() {
  const dir = path.join(HOME, ".openclaw", "openclaw-weixin", "accounts");
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".sync.json"));
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (data.get_updates_buf) return data.get_updates_buf;
    }
  } catch {}
  return null;
}

// ─── 找缓存的 context_token ──────────────────────────────────────────────────

function findCachedContext(userId) {
  try {
    const data = JSON.parse(fs.readFileSync(CONTEXT_CACHE, "utf-8"));
    if (data[userId]?.contextToken) return data[userId].contextToken;
  } catch {}
  return null;
}

// ─── 保存 context_token 到缓存 ───────────────────────────────────────────────

function saveContextCache(userId, contextToken) {
  try {
    fs.mkdirSync(path.dirname(CONTEXT_CACHE), { recursive: true });
    const data = { [userId]: { contextToken, date: new Date().toISOString().slice(0, 10) } };
    fs.writeFileSync(CONTEXT_CACHE, JSON.stringify(data), "utf-8");
  } catch {}
}

// ─── Main ──────────────────────────────────────────────────────────────────

const account = findAccount();
if (!account) {
  console.log("[notify] 未找到账号信息，跳过通知");
  process.exit(0);
}

// 1) 尝试 getUpdates 拿新 token
const syncBuf = findSyncBuf();
let contextToken = null;

if (syncBuf) {
  console.log("[notify] 尝试 getUpdates 获取 context_token...");
  contextToken = await fetchContextToken(account.baseUrl, account.token, syncBuf);
  if (contextToken) {
    console.log("[notify] 从 getUpdates 获取到新 context_token");
    saveContextCache(account.userId, contextToken);
  }
}

// 2) 回退到缓存
if (!contextToken) {
  contextToken = findCachedContext(account.userId);
  if (contextToken) {
    console.log("[notify] 使用缓存的 context_token");
  }
}

if (!contextToken) {
  console.log("[notify] 未找到 context_token，跳过通知");
  process.exit(0);
}

const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const nodeVer = process.version;
const pid = process.ppid || process.pid;
const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);

// 读取 session 状态
const SESSIONS_FILE = path.join(HOME, ".openclaw", "wechat-agent", "sessions.json");
let sessionStatus = "就绪，等待指令";
try {
  const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
  const s = raw.default;
  if (s?.pendingText) {
    const preview = s.pendingText.slice(0, 80) + (s.pendingText.length > 80 ? "..." : "");
    sessionStatus = `有未完成的任务\n上次请求: ${preview}\n回复"继续"可恢复处理`;
  } else if (s?.history?.length > 0) {
    sessionStatus = `就绪，已恢复 ${s.history.length} 条对话记忆`;
  }
} catch {}

const text = [
  `wechat-agent v${PKG.version} (${BUILD}) 已启动`,
  `模型: ${model}  时间: ${now}`,
  ``,
  `支持输入:`,
  `  文字 — 直接发消息对话`,
  `  图片 — 发图片即可识别/分析`,
  `  文件 — 发送文档自动解读`,
  ``,
  `技能:`,
  `  联网搜索 — 新闻、天气、实时信息`,
  `  代码执行 — Python/Node.js/Bash`,
  `  网页抓取 — 获取网页内容、下载图片`,
  `  发送图片 — 找到图片 URL 自动发到聊天`,
  `  专家委派 — 编程/翻译/数据分析`,
  ``,
  `命令: /help /status /tools /usage /clear`,
  ``,
  `${sessionStatus}`,
].join("\n");

try {
  await sendText(account.baseUrl, account.token, account.userId, contextToken, text);
  console.log(`[notify] 已发送重启通知 → ${account.userId.slice(0, 12)}...`);
} catch (err) {
  console.log(`[notify] 发送失败: ${err.message}`);
}
