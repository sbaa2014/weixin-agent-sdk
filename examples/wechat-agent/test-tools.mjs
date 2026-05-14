#!/usr/bin/env node
/**
 * 测试工具调用: 搜索 + 代码执行
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

const connection = new acp.ClientSideConnection(
  () => ({
    requestPermission: async () => ({
      outcome: { outcome: "allowed", optionId: "allow" },
    }),
    sessionUpdate: async (params) => {
      const u = params.update;
      if (u.sessionUpdate === "agent_message_chunk") {
        process.stdout.write(`\n💬 ${u.content?.text || ""}`);
      } else if (u.sessionUpdate === "tool_call") {
        process.stdout.write(`\n🔧 调用工具: ${u.title}`);
      } else if (u.sessionUpdate === "tool_call_update") {
        const text = u.content?.[0]?.content?.text || "";
        process.stdout.write(`\n📋 工具结果: ${text.slice(0, 200)}...`);
      }
    },
  }),
  stream
);

try {
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "test", title: "Test", version: "1.0.0" },
    clientCapabilities: {},
  });
  const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });

  console.log("=== Test: 计算 (应触发 run_code 工具) ===");
  await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "帮我算一下 2 的 100 次方等于多少" }],
  });

  console.log("\n\n✅ Tool test done!");
} catch (err) {
  console.error("\n❌ Failed:", err.message);
} finally {
  proc.kill();
  process.exit(0);
}
