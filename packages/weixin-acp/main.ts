#!/usr/bin/env node

/**
 * WeChat + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx weixin-acp login                          # QR-code login
 *   npx weixin-acp claude-code                     # Start with Claude Code
 *   npx weixin-acp codex                           # Start Codex for all accounts
 *   npx weixin-acp start -- <command> [args...]    # Start with custom agent
 *
 * Examples:
 *   npx weixin-acp start -- node ./my-agent.js
 */

import {
  DEFAULT_ILINK_BOT_TYPE,
  isLoggedIn,
  listWeixinAccountIds,
  login,
  logout,
  normalizeAccountId,
  registerWeixinAccountId,
  renderWeixinQrCodePng,
  saveWeixinAccount,
  sendMessageWeixin,
  sendWeixinMediaFile,
  start,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "weixin-agent-sdk";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AcpAgent } from "./src/acp-agent.js";

/** Built-in agent shortcuts */
const BUILTIN_AGENTS: Record<string, { command: string }> = {
  "claude-code": { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
};

const command = process.argv[2];

async function ensureLoggedIn() {
  if (!isLoggedIn()) {
    console.log("未检测到登录信息，请先扫码登录微信\n");
    await login();
  }
}

function resolveAccountIds(): string[] {
  const configured = process.env.WECHAT_ACCOUNT_IDS?.trim() || process.env.WECHAT_ACCOUNT_ID?.trim();
  const ids = configured
    ? configured.split(",").map((id) => id.trim()).filter(Boolean)
    : listWeixinAccountIds();
  if (ids.length === 0) {
    throw new Error("没有已登录的微信账号，请先运行 login");
  }
  return [...new Set(ids)];
}

async function startAgents(acpCommand: string, acpArgs: string[] = []) {
  await ensureLoggedIn();

  const accountIds = resolveAccountIds();
  console.log(`[weixin] 多租户启动: ${accountIds.join(", ")}`);

  const ac = new AbortController();
  const runtimes = new Map<string, { agent: AcpAgent; bot: ReturnType<typeof start> }>();
  const waiters: Promise<void>[] = [];
  const pendingLogins = new Set<string>();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log("\n正在停止...");
    for (const { agent } of runtimes.values()) agent.dispose();
    ac.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const sendLoginQr = async (params: {
    to: string;
    contextToken?: string;
    baseUrl: string;
    token?: string;
    cdnBaseUrl: string;
    qrcodeUrl: string;
    label: string;
  }) => {
    if (!params.contextToken) {
      throw new Error("缺少管理员微信 context_token，无法发送二维码");
    }
    const png = await renderWeixinQrCodePng(params.qrcodeUrl);
    const dir = path.join(os.tmpdir(), `weixin-agent-${os.userInfo().username}`, "login-qr");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${crypto.randomUUID()}.png`);
    try {
      await fs.writeFile(filePath, png);
      await sendWeixinMediaFile({
        filePath,
        to: params.to,
        text: `${params.label}\n请将此二维码转发给新用户，用微信扫描确认绑定。二维码有效期有限，过期后后台会自动刷新。`,
        opts: { baseUrl: params.baseUrl, token: params.token, contextToken: params.contextToken },
        cdnBaseUrl: params.cdnBaseUrl,
      });
    } finally {
      await fs.unlink(filePath).catch(() => {});
    }
  };

  const addUser = async (params: {
    accountId: string;
    to: string;
    contextToken?: string;
    baseUrl: string;
    cdnBaseUrl: string;
    token?: string;
  }): Promise<void> => {
    if (pendingLogins.has(params.accountId)) {
      await sendMessageWeixin({
        to: params.to,
        text: "已有一个登录绑定二维码正在等待扫码，请先完成或等待它过期。",
        opts: { baseUrl: params.baseUrl, token: params.token, contextToken: params.contextToken },
      });
      return;
    }

    const loginSession = await startWeixinLoginWithQr({
      apiBaseUrl: params.baseUrl,
      botType: DEFAULT_ILINK_BOT_TYPE,
    });
    if (!loginSession.qrcodeUrl) throw new Error(loginSession.message);

    pendingLogins.add(params.accountId);
    try {
      await sendLoginQr({
        ...params,
        qrcodeUrl: loginSession.qrcodeUrl,
        label: "新的微信绑定二维码",
      });
    } catch (error) {
      pendingLogins.delete(params.accountId);
      throw error;
    }

    // Do not block the monitor while waiting for the new user to scan.
    void (async () => {
      try {
        const result = await waitForWeixinLogin({
          sessionKey: loginSession.sessionKey,
          apiBaseUrl: params.baseUrl,
          botType: DEFAULT_ILINK_BOT_TYPE,
          onQrCode: async (qrcodeUrl) => {
            await sendLoginQr({ ...params, qrcodeUrl, label: "二维码已刷新，请转发最新二维码" });
          },
        });
        if (!result.connected || !result.botToken || !result.accountId || !result.userId) {
          await sendMessageWeixin({
            to: params.to,
            text: `❌ 新用户绑定失败：${result.message}`,
            opts: { baseUrl: params.baseUrl, token: params.token, contextToken: params.contextToken },
          });
          return;
        }

        const accountId = normalizeAccountId(result.accountId);
        saveWeixinAccount(accountId, {
          token: result.botToken,
          baseUrl: result.baseUrl,
          userId: result.userId,
        });
        registerWeixinAccountId(accountId);
        startAccount(accountId);
        await sendMessageWeixin({
          to: params.to,
          text: `✅ 新用户绑定成功\n账号: ${accountId}\n用户: ${result.userId}\n已动态启动后台服务，无需重启。`,
          opts: { baseUrl: params.baseUrl, token: params.token, contextToken: params.contextToken },
        });
      } catch (error) {
        try {
          await sendMessageWeixin({
            to: params.to,
            text: `❌ 新用户绑定失败：${error instanceof Error ? error.message : String(error)}`,
            opts: { baseUrl: params.baseUrl, token: params.token, contextToken: params.contextToken },
          });
        } catch {
          console.error(`[weixin] 无法向管理员发送绑定失败通知: ${String(error)}`);
        }
      } finally {
        pendingLogins.delete(params.accountId);
      }
    })();
  };

  function startAccount(accountId: string): void {
    if (runtimes.has(accountId)) return;
    const agent = new AcpAgent({ command: acpCommand, args: acpArgs, accountId });
    const bot = start(agent, {
      accountId,
      abortSignal: ac.signal,
      onAddUser: addUser,
      log: (msg) => console.log(`[${accountId}] ${msg}`),
    });
    runtimes.set(accountId, { agent, bot });
    waiters.push(bot.wait());
  }

  for (const accountId of accountIds) startAccount(accountId);

  const notifyScript = process.env.WECHAT_RESTART_NOTIFY_SCRIPT?.trim();
  if (notifyScript) {
    // Send the welcome message after monitors have initialized. The notifier
    // is best-effort and runs from the cached context token only.
    setTimeout(() => {
      const child = spawn(process.execPath, [notifyScript], {
        stdio: "inherit",
        env: { ...process.env, WECHAT_NOTIFY_CACHE_ONLY: "1" },
      });
      child.on("error", (err) => console.error(`[weixin] 启动通知失败: ${err.message}`));
    }, 2_000);
  }

  try {
    await Promise.all(waiters);
  } finally {
    stop();
  }
}

async function main() {
  if (command === "login") {
    await login();
    return;
  }

  if (command === "logout") {
    logout();
    return;
  }

  if (command === "start") {
    const ddIndex = process.argv.indexOf("--");
    if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
      console.error("错误: 请在 -- 后指定 ACP agent 启动命令");
      console.error("示例: npx weixin-acp start -- codex-acp");
      process.exit(1);
    }

    const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);
    await startAgents(acpCommand, acpArgs);
    return;
  }

  if (command && command in BUILTIN_AGENTS) {
    const { command: acpCommand } = BUILTIN_AGENTS[command];
    await startAgents(acpCommand);
    return;
  }

  console.log(`weixin-acp — 微信 + ACP 适配器

用法:
  npx weixin-acp login                          扫码登录微信
  npx weixin-acp logout                         退出登录
  npx weixin-acp claude-code                    使用 Claude Code（所有账号）
  npx weixin-acp codex                          使用 Codex（所有账号）
  npx weixin-acp start -- <command> [args...]    使用自定义 agent

环境变量:
  WECHAT_ACCOUNT_ID=账号                       只启动一个账号
  WECHAT_ACCOUNT_IDS=账号1,账号2               只启动指定账号
  默认启动所有已登录账号，每个账号使用独立 agent/session

示例:
  npx weixin-acp start -- node ./my-agent.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
