import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { SessionId, Usage } from "@agentclientprotocol/sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

type WechatAccount = { token: string; baseUrl: string; userId: string };

function loadWechatAccount(accountId?: string): WechatAccount | null {
  const dir = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
  try {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json") && !name.includes(".sync"));
    const requested = accountId?.trim();
    const file = (requested ? files.find((name) => name === `${requested}.json`) : undefined) ?? files[0];
    if (!file) return null;
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (data.token && data.baseUrl && data.userId) return data;
  } catch {
    // Direct notifications are best-effort; the normal ACP response remains
    // available if the account cache is not readable.
  }
  return null;
}

function loadWechatContextToken(accountId: string | undefined, userId: string): string | null {
  try {
    const file = path.join(os.homedir(), ".openclaw", "wechat-agent", "last-context.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    // Multi-tenant format: { [accountId]: { [userId]: { contextToken } } }.
    if (accountId && data[accountId]?.[userId]?.contextToken) {
      return data[accountId][userId].contextToken;
    }
    // Backward compatibility with the old single-account format.
    return data[userId]?.contextToken ?? null;
  } catch {
    return null;
  }
}

async function sendProgressToWechat(accountId: string | undefined, conversationId: string, text: string): Promise<boolean> {
  const account = loadWechatAccount(accountId);
  const contextToken = loadWechatContextToken(accountId, conversationId);
  if (!account || !contextToken) return false;

  const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
  try {
    const response = await fetch(`${account.baseUrl.replace(/\/+$/, "")}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${account.token}`,
        "X-WECHAT-UIN": uin,
      },
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: account.userId,
          client_id: `progress-${crypto.randomUUID()}`,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: "1.0.2" },
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

class ProgressNotifier {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private accountId: string | undefined,
    private conversationId: string,
    private readonly startedAt: number,
    private readonly sequence: number,
  ) {}

  start(): void {
    void this.send();
    this.timer = setInterval(() => void this.send(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async send(): Promise<void> {
    const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const duration = min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
    const sent = await sendProgressToWechat(
      this.accountId,
      this.conversationId,
      `[#${String(this.sequence).padStart(3, "0")}] 处理中 | 已用时 ${duration}`,
    );
    if (sent) log(`progress sent conversation=${this.conversationId} elapsed=${elapsed}s`);
  }
}

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  private sessionModels = new Map<string, string>();
  private progressSequences = new Map<string, number>();
  private adminSessions = new Set<SessionId>();
  /**
   * Session namespace for this bridge process. ACP sessions are intentionally
   * never restored across process restarts; this id makes that boundary
   * visible in logs and prevents confusion with old legacy sessions.
   */
  private readonly startupId = crypto.randomUUID();
  private options: AcpAgentOptions;

  constructor(options: AcpAgentOptions) {
    this.options = options;
    const codexProxy = process.env.CODEX_PROXY;
    const childOptions = codexProxy
      ? {
          ...options,
          env: {
            ...options.env,
            HTTP_PROXY: codexProxy,
            HTTPS_PROXY: codexProxy,
            ALL_PROXY: codexProxy,
            http_proxy: codexProxy,
            https_proxy: codexProxy,
            all_proxy: codexProxy,
          },
        }
      : options;
    if (codexProxy) log(`仅 Codex 子进程使用代理: ${codexProxy}`);
    log(`启动新会话批次: ${this.startupId}`);
    this.connection = new AcpConnection(childOptions, () => {
      log("subprocess exited, clearing session cache");
      this.sessions.clear();
      this.sessionModels.clear();
      this.adminSessions.clear();
    }, (sessionId) => this.adminSessions.has(sessionId));
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const conn = await this.connection.ensureReady();

    // Get or create an ACP session for this conversation
    const sessionId = await this.getOrCreateSession(request.conversationId, conn);
    if (this.isAdminUser(request.conversationId)) this.adminSessions.add(sessionId);
    else this.adminSessions.delete(sessionId);

    // Convert the ChatRequest to ACP ContentBlock[]
    const blocks = await convertRequestToContentBlocks(request);
    if (blocks.length === 0) {
      return { text: "" };
    }

    // Register a collector, send the prompt, then gather the response
    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    log(`prompt: "${preview}" (session=${sessionId})`);

    const collector = new ResponseCollector();
    const sequence = (this.progressSequences.get(request.conversationId) ?? 0) + 1;
    this.progressSequences.set(request.conversationId, sequence);
    const progress = new ProgressNotifier(
      this.options.accountId,
      request.conversationId,
      startedAt,
      sequence,
    );
    this.connection.registerCollector(sessionId, collector);
    progress.start();
    let promptResult: { usage?: Usage | null } | undefined;
    const promptTimeoutMs = this.options.promptTimeoutMs ?? 120_000;
    let promptTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      promptResult = await Promise.race([
        conn.prompt({ sessionId, prompt: blocks }),
        new Promise<never>((_, reject) => {
          promptTimeout = setTimeout(() => {
            reject(new Error(`Codex 响应超时（${Math.round(promptTimeoutMs / 1000)}秒），已重置 ACP 会话`));
          }, promptTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Codex 响应超时")) {
        log(`prompt timeout after ${promptTimeoutMs}ms, restarting ACP subprocess`);
        this.connection.dispose();
      }
      throw error;
    } finally {
      if (promptTimeout) clearTimeout(promptTimeout);
      progress.stop();
      this.connection.unregisterCollector(sessionId);
    }

    const response = await collector.toResponse();
    response.text = appendTurnSummary(response.text, Date.now() - startedAt, promptResult?.usage, this.sessionModels.get(request.conversationId));
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
    return response;
  }

  getDebugInfo(conversationId: string): string {
    const sessionId = this.sessions.get(conversationId);
    const child = this.connection.getStatus();
    const accountId = this.options.accountId ?? "default";
    const tools = process.env.WECHAT_MCP_SERVER ? "web_search, run_code, fetch_url, create_pdf" : "Codex 原生工具";
    return [
      "wechat-agent 调试状态",
      `账号: ${accountId}`,
      `启动批次: ${this.startupId}`,
      `微信会话: ${conversationId}`,
      `Codex session: ${sessionId ?? "尚未创建"}`,
      `Codex 模型: ${this.sessionModels.get(conversationId) ?? "尚未创建"}`,
      `ACP 子进程: ${child.ready ? "运行中" : "未启动"}${child.pid ? ` (PID ${child.pid})` : ""}`,
      `工作目录: ${this.options.cwd ?? process.cwd()}`,
      `Codex 代理: ${process.env.CODEX_PROXY ? "已配置" : "未配置"}`,
      `自调试/修改权限: ${process.env.WECHAT_ALLOW_SELF_DEBUG === "1" ? "已允许" : "默认禁止"}`,
      `工具: ${tools}`,
    ].join("\n");
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionId> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    log(`creating fresh session for conversation=${conversationId} startup=${this.startupId}`);
    const mcpServerPath = process.env.WECHAT_MCP_SERVER;
    const mcpServers = mcpServerPath
      ? [{
          name: "wechat_agent_tools",
          command: process.execPath,
          args: [mcpServerPath],
          env: this.options.accountId
            ? [
                { name: "WECHAT_ACCOUNT_ID", value: this.options.accountId },
                { name: "WECHAT_USER_ID", value: conversationId },
              ]
            : [],
        }]
      : [];
    if (mcpServerPath) {
      log(`enabling MCP tools: ${mcpServerPath}`);
    }

    const res = await conn.newSession({
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers,
    });
    log(`fresh session created: ${res.sessionId} model=${res.currentModelId ?? "default"} startup=${this.startupId}`);
    this.sessions.set(conversationId, res.sessionId);
    if (res.currentModelId) this.sessionModels.set(conversationId, String(res.currentModelId));
    return res.sessionId;
  }

  /**
   * Clear/reset the session for a given conversation.
   * The next message will automatically create a fresh session.
   */
  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      log(`clearing session for conversation=${conversationId} (session=${sessionId})`);
      this.connection.unregisterCollector(sessionId);
      this.adminSessions.delete(sessionId);
      this.sessions.delete(conversationId);
      this.progressSequences.delete(conversationId);
    }
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.adminSessions.clear();
    this.sessionModels.clear();
    this.progressSequences.clear();
    this.sessions.clear();
    this.connection.dispose();
  }

  private isAdminUser(userId: string): boolean {
    const configured = process.env.WECHAT_ADMIN_USER_IDS
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
    if (configured.includes(userId)) return true;
    return loadWechatAccount(this.options.accountId)?.userId === userId;
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

function formatTokenCount(value: number | null | undefined): string {
  return value == null ? "ACP 未返回" : String(value);
}

function appendTurnSummary(
  text: string | undefined,
  elapsedMs: number,
  usage: Usage | null | undefined,
  model: string | undefined,
): string {
  const body = text?.trim() ?? "";
  const summary = [
    "\n\n—— 本轮总结 ——",
    `用时: ${formatDuration(elapsedMs)}`,
    ...(model ? [`模型: ${model}`] : []),
    `输入 token: ${formatTokenCount(usage?.inputTokens)}`,
    `输出 token: ${formatTokenCount(usage?.outputTokens)}`,
    ...(usage?.thoughtTokens != null ? [`思考 token: ${usage.thoughtTokens}`] : []),
    `合计 token: ${formatTokenCount(usage?.totalTokens)}`,
  ].join("\n");
  return body ? `${body}${summary}` : summary.trimStart();
}
