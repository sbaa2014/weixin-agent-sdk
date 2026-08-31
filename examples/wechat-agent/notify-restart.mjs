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

function findAccounts() {
  const dir = path.join(HOME, ".openclaw", "openclaw-weixin", "accounts");
  const accounts = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json") && !f.includes(".sync"));
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (data.token && data.baseUrl && data.userId) {
        accounts.push({ ...data, accountId: f.slice(0, -5) });
      }
    }
  } catch { /* ignore */ }
  return accounts;
}

// ─── 找 get_updates_buf ───────────────────────────────────────────────────────

function findSyncBuf(accountId) {
  const dir = path.join(HOME, ".openclaw", "openclaw-weixin", "accounts");
  try {
    const file = path.join(dir, `${accountId}.sync.json`);
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data.get_updates_buf || null;
  } catch { /* ignore */ }
  return null;
}

// ─── 找缓存的 context_token ──────────────────────────────────────────────────

function findCachedContext(accountId, userId) {
  try {
    const data = JSON.parse(fs.readFileSync(CONTEXT_CACHE, "utf-8"));
    if (data[accountId]?.[userId]?.contextToken) return data[accountId][userId].contextToken;
    // Legacy single-account cache.
    if (data[userId]?.contextToken) return data[userId].contextToken;
  } catch {}
  return null;
}

// ─── 保存 context_token 到缓存 ───────────────────────────────────────────────

function saveContextCache(accountId, userId, contextToken) {
  try {
    fs.mkdirSync(path.dirname(CONTEXT_CACHE), { recursive: true });
    const data = {};
    try {
      const old = JSON.parse(fs.readFileSync(CONTEXT_CACHE, "utf-8"));
      if (old && typeof old === "object") Object.assign(data, old);
    } catch {}
    if (!data[accountId] || typeof data[accountId] !== "object") data[accountId] = {};
    data[accountId][userId] = { contextToken, date: new Date().toISOString().slice(0, 10) };
    fs.writeFileSync(CONTEXT_CACHE, JSON.stringify(data), "utf-8");
  } catch {}
}

// ─── Main ──────────────────────────────────────────────────────────────────

const accounts = findAccounts();
if (accounts.length === 0) {
  console.log("[notify] 未找到账号信息，跳过通知");
  process.exit(0);
}

const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

// Read the Codex model only; do not display the old Claude model setting.
function loadConfiguredModel() {
  if (process.env.CODEX_MODEL) return process.env.CODEX_MODEL;
  try {
    const configPath = path.join(HOME, ".codex", "config.toml");
    const config = fs.readFileSync(configPath, "utf-8");
    return config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

const model = loadConfiguredModel() || "Codex（本机配置）";
const nodeVer = process.version;
const pid = process.ppid || process.pid;
const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);

for (const account of accounts) {
  // 1) 尝试从本账号 getUpdates 拿 context token
  const syncBuf = findSyncBuf(account.accountId);
  let contextToken = process.env.WECHAT_NOTIFY_CACHE_ONLY === "1"
    ? null
    : (syncBuf ? await fetchContextToken(account.baseUrl, account.token, syncBuf) : null);
  if (contextToken) {
    saveContextCache(account.accountId, account.userId, contextToken);
  }

  // 2) 回退到本账号缓存
  if (!contextToken) contextToken = findCachedContext(account.accountId, account.userId);
  if (!contextToken) {
    console.log(`[notify] account=${account.accountId} 未找到 context_token，跳过`);
    continue;
  }

  const text = [
    `wechat-agent v${PKG.version} (${BUILD}) 已启动`,
    `模型: ${model}  时间: ${now}`,
    `Node: ${nodeVer}  PID: ${pid}  内存: ${mem}MB`,
    `账号: ${account.accountId}`,
    `会话: 本次启动使用新的 Codex 会话，不恢复旧版 Claude 对话`,
    "",
    "支持输入:",
    "  文字 — 直接发消息对话",
    "  图片 — 发图片即可识别/分析",
    "  文件 — 发送文档自动解读",
    "",
    "技能:",
    "  联网搜索 — 新闻、天气、实时信息",
    "  代码执行 — Python/Node.js/Bash",
    "  网页抓取 — 获取网页内容、下载图片",
    "  发送图片 — 找到图片 URL 自动发到聊天",
    "",
    "状态: 就绪，等待消息（首条消息到达时创建 Codex session）",
    "",
    "命令: /help /status /tools /usage /clear",
  ].join("\n");

  try {
    await sendText(account.baseUrl, account.token, account.userId, contextToken, text);
    console.log(`[notify] 已发送重启通知 account=${account.accountId}`);
  } catch (err) {
    console.log(`[notify] 发送失败 account=${account.accountId}: ${err.message}`);
  }
}
