#!/usr/bin/env node
/**
 * 启动后向上次活跃用户推送重启通知
 *
 * 读取顺序:
 *   1. ~/wechat-agent/last-context.json         (自己保存的，最优先)
 *   2. ~/.wechat-acp/last-contexts.json     (wechat-acp 保存的)
 *   3. ~/.openclaw/.../accounts/*.json       (weixin-acp 保存的，需配合 getconfig)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const HOME = os.homedir();
const AGENT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PKG = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "package.json"), "utf-8"));
const BUILD = (() => {
  try { return parseInt(fs.readFileSync(path.join(AGENT_DIR, ".build"), "utf-8").trim(), 10) || 0; }
  catch { return 0; }
})();

function randomUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}

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

// ─── 找 context_token ──────────────────────────────────────────────────────

function findContext(userId) {
  // 1. 自己保存的
  try {
    const data = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "last-context.json"), "utf-8"));
    if (data.userId === userId && data.contextToken) return data.contextToken;
  } catch {}

  // 2. wechat-acp 保存的
  try {
    const data = JSON.parse(fs.readFileSync(path.join(HOME, ".wechat-acp", "last-contexts.json"), "utf-8"));
    if (data[userId]?.contextToken) return data[userId].contextToken;
  } catch {}

  return null;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const account = findAccount();
if (!account) {
  console.log("[notify] 未找到账号信息，跳过通知");
  process.exit(0);
}

const contextToken = findContext(account.userId);
if (!contextToken) {
  console.log("[notify] 未找到 context_token，跳过通知");
  process.exit(0);
}

const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
const text = [
  `[重启通知] wechat-agent v${PKG.version} (build ${BUILD})`,
  `模型: ${process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514"}`,
  `时间: ${now}`,
].join("\n");

try {
  await sendText(account.baseUrl, account.token, account.userId, contextToken, text);
  console.log(`[notify] 已发送重启通知 → ${account.userId.slice(0, 12)}...`);
} catch (err) {
  console.log(`[notify] 发送失败: ${err.message}`);
}
