#!/usr/bin/env node
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
    requestPermission: async () => ({ outcome: { outcome: "allowed", optionId: "allow" } }),
    sessionUpdate: async (params) => {
      if (params.update.sessionUpdate === "agent_message_chunk") {
        process.stdout.write(params.update.content?.text || "");
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

  console.log("=== /version ===");
  await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "/version" }],
  });

  console.log("\n\n=== 版本 ===");
  await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "版本" }],
  });

  console.log("\n\n=== /help ===");
  await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "/help" }],
  });
} catch (err) {
  console.error("\nFailed:", err.message);
} finally {
  proc.kill();
  process.exit(0);
}
