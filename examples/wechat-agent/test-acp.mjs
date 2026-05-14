#!/usr/bin/env node
/**
 * 快速测试: 模拟 ACP 客户端连接自定义 agent
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const proc = spawn("node", ["./agent.mjs"], {
  cwd: "/home/claude3/my-agent",
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

const input = Writable.toWeb(proc.stdin);
const output = Readable.toWeb(proc.stdout);
const stream = acp.ndJsonStream(input, output);

const updates = [];

const connection = new acp.ClientSideConnection(
  (agent) => ({
    requestPermission: async (params) => ({
      outcome: { outcome: "allowed", optionId: "allow" },
    }),
    sessionUpdate: async (params) => {
      updates.push(params.update);
      if (params.update.sessionUpdate === "agent_message_chunk") {
        process.stdout.write(`[Agent] ${params.update.content?.text || ""}\n`);
      }
      if (params.update.sessionUpdate === "tool_call") {
        process.stdout.write(`[Tool] ${params.update.title} ...\n`);
      }
      if (params.update.sessionUpdate === "tool_call_update") {
        process.stdout.write(`[Tool] done\n`);
      }
    },
  }),
  stream
);

try {
  console.log("=== Initializing ACP connection ===");
  const initResp = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "test-client", title: "Test", version: "1.0.0" },
    clientCapabilities: {},
  });
  console.log(`Protocol: v${initResp.protocolVersion}`);

  console.log("=== Creating session ===");
  const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
  console.log(`Session ID: ${session.sessionId}`);

  console.log("=== Sending prompt: '你好，请介绍一下你自己' ===");
  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "你好，请介绍一下你自己" }],
  });
  console.log(`\n=== Stop reason: ${result.stopReason} ===`);
  console.log(`Total updates received: ${updates.length}`);
  console.log("\n✅ ACP test passed!");
} catch (err) {
  console.error("❌ Test failed:", err.message);
} finally {
  proc.kill();
  process.exit(0);
}
