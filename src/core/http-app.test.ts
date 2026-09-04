import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createHttpApp, parseMcpOutput } from "./http-app.js";
import { McpRegistry } from "./mcp-registry.js";
import type { McpConfigManager } from "./plugin.js";
import { startHttpServer } from "./start-http-server.js";
import { createSshPlugin } from "../plugins/ssh/index.js";

test("gateway exposes the SSH plugin over its mounted MCP path", async (context) => {
  const calls: string[] = [];
  const logs: Array<{
    level: "info" | "error";
    event: string;
    fields: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "test-gateway",
    logger: {
      info: (event, fields) => logs.push({ level: "info", event, fields }),
      error: (event, fields) => logs.push({ level: "error", event, fields }),
    },
    mounts: [{
      path: "/ssh/mcp",
      plugin: createSshPlugin({
        config: {
          allowedTargets: new Set(["test-host"]),
          allowCommands: false,
          username: "test-user",
          ports: [2222],
        },
        executor: async (request) => {
          calls.push(`${request.target}:${request.command}`);
          return {
            target: request.target,
            username: "test-user",
            port: 2222,
            attemptedPorts: [2222],
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

  const response = await fetch(new URL("/ssh/mcp", url), {
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

  const healthResponse = await fetch(new URL("/health", url));
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: "ok" });

  const legacyHealthResponse = await fetch(new URL("/healthz", url));
  assert.equal(legacyHealthResponse.status, 200);
  assert.deepEqual(await legacyHealthResponse.json(), { status: "ok" });

  const statusResponse = await fetch(new URL("/api/status", url));
  const statusBody = await statusResponse.json() as {
    endpoints: Array<{
      id: string;
      category: { id: string; name: string; description: string };
      path: string;
    }>;
  };

  assert.equal(statusResponse.status, 200);
  assert.equal(statusBody.endpoints[0]?.path, "/ssh/mcp");
  assert.deepEqual(statusBody.endpoints[0]?.category, {
    id: "remote-operations",
    name: "远程运维",
    description: "连接和诊断远程 Linux/Unix 主机。",
  });

  const toolResponse = await fetch(new URL("/ssh/mcp", url), {
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

  const requestLog = logs.find(
    (entry) => entry.event === "mcp.request"
      && entry.fields?.rpc_method === "tools/call",
  );
  assert.equal(requestLog?.fields?.plugin, "ssh");
  assert.equal(requestLog?.fields?.endpoint, "/ssh/mcp");
  assert.equal(requestLog?.fields?.http_method, "POST");
  assert.equal(requestLog?.fields?.rpc_id, 2);
  assert.equal(requestLog?.fields?.tool, "ssh_get_system_snapshot");
  assert.deepEqual(requestLog?.fields?.input, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "ssh_get_system_snapshot",
      arguments: { target: "test-host" },
    },
  });

  const responseLog = logs.find(
    (entry) => entry.event === "mcp.response"
      && entry.fields?.request_id === requestLog?.fields?.request_id,
  );
  assert.equal(responseLog?.fields?.status, 200);
  assert.match(JSON.stringify(responseLog?.fields?.output), /test-host/);
});

test("unauthenticated app refuses a non-loopback bind", () => {
  assert.throws(
    () => createHttpApp({ host: "0.0.0.0", serviceName: "unsafe", mounts: [] }),
    /Refusing to run unauthenticated MCP service/,
  );
});

test("app enforces the /<plugin-id>/mcp endpoint convention", () => {
  assert.throws(
    () => createHttpApp({
      host: "127.0.0.1",
      serviceName: "invalid-path",
      logger: { info: () => undefined, error: () => undefined },
      mounts: [{
        path: "/mcp/ssh",
        plugin: createSshPlugin({
          config: { allowedTargets: new Set(), allowCommands: false, ports: [] },
        }),
      }],
    }),
    /expected \/ssh\/mcp, received \/mcp\/ssh/,
  );
});

test("MCP log output removes the SSE envelope", () => {
  assert.deepEqual(
    parseMcpOutput('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n'),
    { jsonrpc: "2.0", id: 2, result: { ok: true } },
  );
  assert.deepEqual(parseMcpOutput('{"status":"ok"}'), { status: "ok" });
  assert.equal(parseMcpOutput("plain output\n"), "plain output");
});

test("configuration API replaces the active plugin only after a successful update", async (context) => {
  const initialPlugin = createSshPlugin({
    config: { allowedTargets: new Set(), allowCommands: false, ports: [] },
  });
  const replacementPlugin = { ...initialPlugin, summary: "reloaded plugin" };
  const registry = new McpRegistry([{ path: "/ssh/mcp", plugin: initialPlugin }]);
  let failUpdate = false;
  const manager: McpConfigManager = {
    pluginId: "ssh",
    getSnapshot: () => ({
      pluginId: "ssh",
      fields: [],
      values: {},
      revision: 0,
      updatedAt: null,
    }),
    update: async () => {
      if (failUpdate) throw new Error("invalid settings");
      return {
        plugin: replacementPlugin,
        snapshot: {
          pluginId: "ssh",
          fields: [],
          values: {},
          revision: 1,
          updatedAt: "2026-09-03T10:00:00.000Z",
        },
        changedKeys: ["SSH_MCP_ALLOWED_TARGETS"],
      };
    },
    reload: async () => ({
      plugin: replacementPlugin,
      snapshot: manager.getSnapshot(),
      changedKeys: [],
    }),
  };
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "config-test",
    logger: { info: () => undefined, error: () => undefined },
    registry,
    configManagers: [manager],
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  const getResponse = await fetch(new URL("/api/config/ssh", url));
  assert.equal(getResponse.status, 200);
  const updateResponse = await fetch(new URL("/api/config/ssh", url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: {} }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal(registry.get("ssh")?.plugin.summary, "reloaded plugin");

  registry.replace("ssh", initialPlugin);
  failUpdate = true;
  const failedResponse = await fetch(new URL("/api/config/ssh", url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: {} }),
  });
  assert.equal(failedResponse.status, 400);
  assert.equal(registry.get("ssh")?.plugin, initialPlugin);
});
