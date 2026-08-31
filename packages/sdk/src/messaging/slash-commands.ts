/**
 * Weixin 斜杠指令处理模块
 *
 * 支持的指令：
 * - /echo <message>         直接回复消息（不经过 AI），并附带通道耗时统计
 * - /toggle-debug           开关 debug 模式，启用后每条 AI 回复追加全链路耗时
 * - /clear                  清除当前会话，重新开始对话
 * - /status                 查看 bridge、账号和 ACP session 状态
 * - /tools                  查看当前 Codex 可用工具
 * - /whoami                 查看自己的微信用户 ID
 * - /add-user               由管理员生成新的微信登录绑定二维码
 * - /allow-user <userId>    由管理员添加一个已有用户
 * - /users                  由管理员查看允许使用的用户
 * - /help                   查看微信侧调试命令
 */
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { readFrameworkAllowFromList, registerUserInAllowFromStore } from "../auth/pairing.js";

import { toggleDebugMode, isDebugMode } from "./debug-mode.js";
import { sendMessageWeixin } from "./send.js";

export interface SlashCommandResult {
  /** 是否是斜杠指令（true 表示已处理，不需要继续走 AI） */
  handled: boolean;
}

export interface SlashCommandContext {
  to: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  accountId: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  /** Called when /clear is invoked to reset the agent session. */
  onClear?: () => void;
  /** Diagnostic callback; must not invoke the model. */
  getDebugInfo?: () => string | Promise<string>;
  /** Whether this sender may inspect or change agent debug state. */
  isAdmin?: boolean;
  /** Start a new login binding flow and deliver its QR code to this sender. */
  onAddUser?: (params: {
    accountId: string;
    to: string;
    contextToken?: string;
    baseUrl: string;
    cdnBaseUrl: string;
    token?: string;
  }) => Promise<void>;
}

/** 发送回复消息 */
async function sendReply(ctx: SlashCommandContext, text: string): Promise<void> {
  const opts: WeixinApiOptions & { contextToken?: string } = {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    contextToken: ctx.contextToken,
  };
  await sendMessageWeixin({ to: ctx.to, text, opts });
}

/** 处理 /echo 指令 */
async function handleEcho(
  ctx: SlashCommandContext,
  args: string,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }
  const eventTs = eventTimestamp ?? 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
  const timing = [
    "⏱ 通道耗时",
    `├ 事件时间: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
    `├ 平台→插件: ${platformDelay}`,
    `└ 插件处理: ${Date.now() - receivedAt}ms`,
  ].join("\n");
  await sendReply(ctx, timing);
}

/**
 * 尝试处理斜杠指令
 *
 * @returns handled=true 表示该消息已作为指令处理，不需要继续走 AI 管道
 */
export async function handleSlashCommand(
  content: string,
  ctx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  logger.info(`[weixin] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true };
      case "/toggle-debug": {
        if (!ctx.isAdmin) {
          await sendReply(ctx, "⛔ 只有此微信账号的管理员可以切换调试模式");
          return { handled: true };
        }
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? "Debug 模式已开启"
            : "Debug 模式已关闭",
        );
        return { handled: true };
      }
      case "/clear": {
        ctx.onClear?.();
        await sendReply(ctx, "✅ 会话已清除，重新开始对话");
        return { handled: true };
      }
      case "/whoami": {
        await sendReply(ctx, `你的微信用户 ID:\n${ctx.to}`);
        return { handled: true };
      }
      case "/add-user": {
        if (!ctx.isAdmin) {
          await sendReply(ctx, "⛔ 只有 root/管理员可以添加用户");
          return { handled: true };
        }
        if (!ctx.onAddUser) {
          await sendReply(ctx, "❌ 当前服务未启用动态登录绑定");
          return { handled: true };
        }
        await ctx.onAddUser({
          accountId: ctx.accountId,
          to: ctx.to,
          contextToken: ctx.contextToken,
          baseUrl: ctx.baseUrl,
          cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
          token: ctx.token,
        });
        await sendReply(ctx, "✅ 已在后台启动新的微信绑定，请查看下面的二维码并转发给新用户扫码。");
        return { handled: true };
      }
      case "/allow-user": {
        if (!ctx.isAdmin) {
          await sendReply(ctx, "⛔ 只有 root/管理员可以授权用户");
          return { handled: true };
        }
        const userId = args.trim().split(/\s+/)[0] ?? "";
        if (!userId) {
          await sendReply(ctx, "用法: /allow-user <已有微信用户ID>");
          return { handled: true };
        }
        const result = registerUserInAllowFromStore({ accountId: ctx.accountId, userId });
        await sendReply(ctx, result.changed ? `✅ 已授权用户:\n${userId}` : `用户已在白名单中:\n${userId}`);
        return { handled: true };
      }
      case "/users": {
        if (!ctx.isAdmin) {
          await sendReply(ctx, "⛔ 只有 root/管理员可以查看用户列表");
          return { handled: true };
        }
        const users = readFrameworkAllowFromList(ctx.accountId);
        await sendReply(
          ctx,
          users.length > 0
            ? [`当前账号允许的用户 (${users.length}):`, ...users].join("\n")
            : "当前未启用用户白名单（所有收到的联系人消息都会处理）",
        );
        return { handled: true };
      }
      case "/status":
      case "/session": {
        if (!ctx.isAdmin) {
          await sendReply(ctx, "⛔ 只有此微信账号的管理员可以查看调试状态");
          return { handled: true };
        }
        const status = ctx.getDebugInfo
          ? await ctx.getDebugInfo()
          : "当前 agent 未提供诊断信息";
        await sendReply(ctx, status);
        return { handled: true };
      }
      case "/tools": {
        await sendReply(ctx, [
          "当前 Codex 工具:",
          "  web_search — 联网搜索",
          "  run_code — 执行 Python/Node.js/Bash",
          "  fetch_url — 抓取网页/下载图片",
          "",
          "ACP 原生工具由 Codex 自己管理。",
        ].join("\n"));
        return { handled: true };
      }
      case "/help":
      case "/h": {
        await sendReply(ctx, [
          "微信调试命令:",
          "  /status (状态) — 查看账号、session、ACP 进程",
          "  /tools (工具) — 查看当前工具",
          "  /whoami — 查看自己的微信用户 ID",
          "  /add-user — root 生成新的微信登录绑定二维码",
          "  /allow-user <ID> — root 授权已有联系人",
          "  /users — root 查看允许使用的用户",
          "  /clear (清空) — 清除当前微信会话",
          "  /toggle-debug — 开关耗时调试",
          "  /echo 文本 — 测试微信通道延迟",
          "  /help (帮助) — 显示此帮助",
        ].join("\n"));
        return { handled: true };
      }
      case "/usage": {
        await sendReply(ctx, "当前 ACP 适配器未暴露 Codex token 用量；可用 /status 检查连接状态。");
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  } catch (err) {
    logger.error(`[weixin] Slash command error: ${String(err)}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败: ${String(err).slice(0, 200)}`);
    } catch {
      // 发送错误消息也失败了，只能记日志
    }
    return { handled: true };
  }
}
