#!/usr/bin/env node
/**
 * MCP adapter for the original wechat-agent tools.
 *
 * Codex starts this process through a stdio MCP server entry in the ACP
 * session. The actual implementations remain in agent.mjs so the old agent
 * and Codex mode share the same search, code and image handling behavior.
 */

import readline from "node:readline";

// MCP tools should access the web directly. The proxy is injected only into
// the Codex ACP child, not into this tool process.
for (const key of [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "all_proxy",
]) delete process.env[key];

const { MCP_TOOL_DEFINITIONS, callToolFromMcp } = await import("./agent.mjs");

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function errorReply(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  })}\n`);
}

async function handle(message) {
  const { id, method, params = {} } = message;

  // MCP notifications do not receive a response.
  if (typeof id === "undefined") return;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wechat-agent-tools", version: "1.0.1" },
      });
      return;

    case "ping":
      reply(id, {});
      return;

    case "tools/list":
      reply(id, { tools: MCP_TOOL_DEFINITIONS });
      return;

    case "tools/call": {
      const name = params.name;
      try {
        const result = await callToolFromMcp(name, params.arguments || {});
        reply(id, {
          content: [{ type: "text", text: String(result ?? "") }],
          isError: false,
        });
      } catch (error) {
        reply(id, {
          content: [{ type: "text", text: `工具执行失败: ${error.message}` }],
          isError: true,
        });
      }
      return;
    }

    default:
      errorReply(id, -32601, `Method not found: ${method}`);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    errorReply(null, -32700, `Invalid JSON: ${error.message}`);
    return;
  }
  void handle(message).catch((error) => {
    if (typeof message.id !== "undefined") errorReply(message.id, -32603, error.message);
  });
});
