import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createHttpApp } from "./http-app.js";
import { startHttpServer } from "./start-http-server.js";
import { createSshPlugin } from "../plugins/ssh/index.js";

test("gateway exposes the SSH plugin over its mounted MCP path", async (context) => {
  const calls: string[] = [];
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "test-gateway",
    mounts: [{
      path: "/mcp/ssh",
      plugin: createSshPlugin({
        config: { allowedTargets: new Set(["test-host"]), allowCommands: false },
        executor: async (request) => {
          calls.push(`${request.target}:${request.command}`);
          return {
            target: request.target,
            command: request.command,
            exitCode: 0,
            signal: null,
            durationMs: 5,
            stdout: "test-host\n",
            stderr: "",
            outputTruncated: false,
          };
        },
      }),
    }],
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  const response = await fetch(new URL("/mcp/ssh", url), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /ssh_get_system_snapshot/);
  assert.match(body, /ssh_execute_command/);

  const statusResponse = await fetch(new URL("/api/status", url));
  const statusBody = await statusResponse.json() as {
    endpoints: Array<{
      id: string;
      category: { id: string; name: string; description: string };
    }>;
  };

  assert.equal(statusResponse.status, 200);
  assert.deepEqual(statusBody.endpoints[0]?.category, {
    id: "remote-operations",
    name: "远程运维",
    description: "连接和诊断远程 Linux/Unix 主机。",
  });

  const toolResponse = await fetch(new URL("/mcp/ssh", url), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ssh_get_system_snapshot",
        arguments: { target: "test-host" },
      },
    }),
  });
  const toolBody = await toolResponse.text();

  assert.equal(toolResponse.status, 200);
  assert.match(toolBody, /test-host\\n/);
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /^test-host:id; hostname;/);
});

test("unauthenticated app refuses a non-loopback bind", () => {
  assert.throws(
    () => createHttpApp({ host: "0.0.0.0", serviceName: "unsafe", mounts: [] }),
    /Refusing to run unauthenticated MCP service/,
  );
});
