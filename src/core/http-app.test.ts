import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod/v4";

import { createHttpApp, parseMcpOutput } from "./http-app.js";
import { McpRegistry } from "./mcp-registry.js";
import { createGenericConfigManager } from "./plugin-config-manager.js";
import type {
  McpConfigManager,
  PersonalMcpPlugin,
  PluginConfigField,
  PluginConfigSnapshot,
} from "./plugin.js";
import { startHttpServer } from "./start-http-server.js";
import { createSshPlugin } from "../plugins/ssh/index.js";
import { ConfigFieldEditor, ToolMetadataRow } from "../ui/MetadataControls.js";

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
  assert.equal(responseLog?.fields?.output, undefined);
});

test("unauthenticated app refuses a non-loopback bind", () => {
  assert.throws(
    () => createHttpApp({ host: "0.0.0.0", serviceName: "unsafe", mounts: [] }),
    /Refusing to run unauthenticated MCP service/,
  );
});

test("status exposes optional Plugin health and isolates a failed check", async (context) => {
  const serverSource = createSshPlugin({
    config: { allowedTargets: new Set(), allowCommands: false, ports: [] },
  });
  const plugin = (
    id: string,
    checkHealth?: PersonalMcpPlugin["checkHealth"],
  ): PersonalMcpPlugin => ({
    id,
    displayName: id,
    summary: "health integration test",
    category: { id: "test", name: "Test", description: "Test Plugins" },
    tools: [],
    createServer: serverSource.createServer,
    ...(checkHealth === undefined ? {} : { checkHealth }),
  });
  const logs: Array<{ event: string; fields?: Readonly<Record<string, unknown>> }> = [];
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "health-test",
    logger: {
      info: (event, fields) => logs.push({ event, ...(fields === undefined ? {} : { fields }) }),
      error: (event, fields) => logs.push({ event, ...(fields === undefined ? {} : { fields }) }),
    },
    mounts: [
      { path: "/unknown/mcp", plugin: plugin("unknown") },
      { path: "/unconfigured/mcp", plugin: plugin("unconfigured", async () => ({ state: "unconfigured", message: "Add backend settings" })) },
      { path: "/healthy/mcp", plugin: plugin("healthy", async () => ({ state: "healthy", message: "Backend available" })) },
      { path: "/degraded/mcp", plugin: plugin("degraded", async () => ({
        state: "degraded",
        message: "Backend is responding slowly",
        latencyMs: 125.5,
        checkedAt: "2026-09-09T01:02:03.000Z",
      })) },
      { path: "/failed/mcp", plugin: plugin("failed", async () => { throw new Error("backend unavailable"); }) },
      { path: "/extra-data/mcp", plugin: plugin("extra-data", async () => ({
        state: "healthy",
        unexpectedSecret: "must-not-reach-status",
      } as import("./plugin.js").PluginHealth & { readonly unexpectedSecret: string })) },
    ],
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  const healthCheck = await fetch(new URL("/api/health/check", url), { method: "POST" });
  assert.equal(healthCheck.status, 200);
  const response = await fetch(new URL("/api/status", url));
  const responseText = await response.text();
  assert.doesNotMatch(responseText, /must-not-reach-status|unexpectedSecret/);
  const status = JSON.parse(responseText) as {
    endpoints: Array<{ id: string; health: import("./plugin.js").PluginHealth }>;
  };
  assert.equal(response.status, 200);
  assert.deepEqual(status.endpoints.find(({ id }) => id === "unknown")?.health, { state: "unknown" });
  const unconfigured = status.endpoints.find(({ id }) => id === "unconfigured")?.health;
  assert.equal(unconfigured?.state, "unconfigured");
  assert.equal(unconfigured?.message, "Add backend settings");
  const healthy = status.endpoints.find(({ id }) => id === "healthy")?.health;
  assert.equal(healthy?.state, "healthy");
  assert.equal(healthy?.message, "Backend available");
  assert.equal(typeof healthy?.latencyMs, "number");
  assert.ok(healthy?.checkedAt !== undefined);
  assert.deepEqual(status.endpoints.find(({ id }) => id === "degraded")?.health, {
    state: "degraded",
    message: "Backend is responding slowly",
    latencyMs: 125.5,
    checkedAt: "2026-09-09T01:02:03.000Z",
  });
  const failed = status.endpoints.find(({ id }) => id === "failed")?.health;
  assert.equal(failed?.state, "unhealthy");
  assert.equal(failed?.message, "Health check failed");
  assert.ok(logs.some((entry) => entry.event === "plugin.health_check_failed"
    && entry.fields?.plugin === "failed"));

  const gatewayHealth = await fetch(new URL("/health", url));
  assert.equal(gatewayHealth.status, 200);
  assert.deepEqual(await gatewayHealth.json(), { status: "ok" });
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
  let replaceRuntime: ((plugin: PersonalMcpPlugin) => void) | undefined;
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
      replaceRuntime?.(replacementPlugin);
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
    setRuntimeReplacement: (replace) => { replaceRuntime = replace; },
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

test("configuration status, errors, and logs never expose Secret values", async (context) => {
  const fields: readonly PluginConfigField[] = [{
    key: "TOKEN",
    label: "Token",
    description: "Secret token",
    type: "password",
    defaultValue: "metadata-secret",
    secret: true,
  }];
  const serverSource = createSshPlugin({
    config: {
      allowedTargets: new Set(["old-secret"]),
      allowCommands: false,
      username: "reader",
      ports: [22],
    },
    executor: async (request) => ({
      target: request.target,
      username: "reader",
      port: 22,
      attemptedPorts: [22],
      command: request.command,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: "old-secret\n",
      stderr: "",
      outputTruncated: false,
    }),
  });
  const plugin: PersonalMcpPlugin = {
    id: "secret-test",
    displayName: "Secret Test",
    summary: "secret boundary",
    category: { id: "test", name: "Test", description: "Test plugins" },
    tools: [],
    config: { fields },
    createServer: serverSource.createServer,
  };
  const manager = createGenericConfigManager({
    pluginId: plugin.id,
    fields,
    store: { environment: () => ({ TOKEN: "old-secret" }), update: async () => undefined },
    load: (environment) => ({ token: environment.TOKEN ?? "" }),
    values: (config) => ({ TOKEN: config.token }),
    parse: (input, current) => ({
      ...current,
      ...((input as { values: Record<string, string> }).values),
    }),
    environment: (values, base) => ({ ...base, TOKEN: String(values.TOKEN ?? "") }),
    persist: (values) => ({ TOKEN: String(values.TOKEN ?? "") }),
    validate: (config) => { throw new Error(`Rejected token ${config.token}; old value old-secret`); },
    createPlugin: () => plugin,
  });
  const logs: Array<{
    event: string;
    fields: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "secret-test",
    logger: {
      info: (event, logFields) => logs.push({ event, fields: logFields }),
      error: (event, logFields) => logs.push({ event, fields: logFields }),
    },
    mounts: [{ path: "/secret-test/mcp", plugin }],
    configManagers: [manager],
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  const statusResponse = await fetch(new URL("/api/status", url));
  const statusText = await statusResponse.text();
  assert.doesNotMatch(statusText, /old-secret|metadata-secret/);
  assert.match(statusText, /"TOKEN":\{"configured":true\}/);
  const status = JSON.parse(statusText) as { configs: PluginConfigSnapshot[] };
  assert.equal(status.configs[0]?.fields[0]?.defaultValue, "");

  const toolResponse = await fetch(new URL("/secret-test/mcp", url), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ssh_get_system_snapshot",
        arguments: { target: "old-secret" },
      },
    }),
  });
  assert.equal(toolResponse.status, 200);
  assert.match(await toolResponse.text(), /old-secret/);

  const updateResponse = await fetch(new URL("/api/config/secret-test", url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { TOKEN: "new-secret" } }),
  });
  const errorText = await updateResponse.text();
  assert.equal(updateResponse.status, 400);
  assert.doesNotMatch(errorText, /old-secret|new-secret/);
  assert.match(errorText, /\[REDACTED\]/);
  const logText = JSON.stringify(logs);
  assert.doesNotMatch(logText, /old-secret|new-secret/);
  assert.match(logText, /\[REDACTED\]/);
});

test("status exposes rich schema and risk metadata from a test plugin", async (context) => {
  const richFields: readonly PluginConfigField[] = [
    { key: "TEXT", label: "Text", description: "text", type: "text", defaultValue: "", required: true, placeholder: "value", group: { id: "general", label: "General" } },
    { key: "PASSWORD", label: "Password", description: "password", type: "password", defaultValue: "", secret: true },
    { key: "NUMBER", label: "Number", description: "number", type: "number", defaultValue: 3 },
    { key: "BOOLEAN", label: "Boolean", description: "boolean", type: "boolean", defaultValue: false, dangerous: true },
    { key: "SELECT", label: "Select", description: "select", type: "select", defaultValue: "a", options: [{ value: "a", label: "A" }] },
    { key: "MULTI", label: "Multi", description: "multi", type: "multiselect", defaultValue: ["a"], options: [{ value: "a", label: "A" }] },
    { key: "TEXTAREA", label: "Textarea", description: "textarea", type: "textarea", defaultValue: "" },
    { key: "PATH", label: "Path", description: "path", type: "path", defaultValue: "" },
  ];
  const serverSource = createSshPlugin({
    config: { allowedTargets: new Set(), allowCommands: false, ports: [] },
  });
  const plugin: PersonalMcpPlugin = {
    id: "schema-test",
    displayName: "Schema Test",
    summary: "metadata-driven test plugin",
    category: { id: "test", name: "Test", description: "Test plugins" },
    tools: [
      { name: "read", title: "Read", risk: "read-only" },
      { name: "write", title: "Write", risk: "write" },
      { name: "delete", title: "Delete", risk: "destructive", requiresConfirmation: true },
      { name: "admin", title: "Admin", risk: "privileged", requiresConfirmation: true, disabledByDefault: true },
      { name: "legacy", title: "Legacy write", risk: "write-capable" },
    ],
    config: { fields: richFields },
    createServer: serverSource.createServer,
  };
  const manager: McpConfigManager = {
    pluginId: plugin.id,
    getSnapshot: () => ({
      pluginId: plugin.id,
      fields: richFields,
      values: { TEXT: "configured", NUMBER: 3, BOOLEAN: false, MULTI: ["a"] },
      revision: 0,
      updatedAt: null,
    }),
    update: async () => { throw new Error("not used"); },
    reload: async () => { throw new Error("not used"); },
  };
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "schema-test",
    logger: { info: () => undefined, error: () => undefined },
    mounts: [{ path: "/schema-test/mcp", plugin }],
    configManagers: [manager],
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  const response = await fetch(new URL("/api/status", url));
  const status = await response.json() as {
    endpoints: Array<{ tools: PersonalMcpPlugin["tools"] }>;
    configs: PluginConfigSnapshot[];
  };
  assert.equal(response.status, 200);
  assert.deepEqual(status.endpoints[0]?.tools, plugin.tools);
  assert.deepEqual(status.configs[0]?.fields, richFields);

  const config = status.configs[0];
  assert.ok(config);
  const configMarkup = config.fields.map((field) => renderToStaticMarkup(createElement(
    ConfigFieldEditor,
    {
      field,
      pluginId: config.pluginId,
      saving: false,
      value: config.values[field.key] ?? field.defaultValue,
      update: () => undefined,
    },
  ))).join("\n");
  const toolMarkup = (status.endpoints[0]?.tools ?? []).map((tool) => renderToStaticMarkup(
    createElement(ToolMetadataRow, { tool }),
  )).join("\n");
  assert.match(configMarkup, /type="password"/);
  assert.match(configMarkup, /<select[^>]*multiple=""/);
  assert.match(configMarkup, /data-config-type="path"/);
  assert.match(toolMarkup, /调用前确认/);
  assert.match(toolMarkup, /默认停用/);
});

test("gateway centrally enforces Tool input and output logging policies", async (context) => {
  const secret = "central-policy-secret";
  const tools: PersonalMcpPlugin["tools"] = [
    { name: "full", title: "Full", risk: "read-only", logging: { input: "full", output: "full" } },
    { name: "metadata", title: "Metadata", risk: "read-only", logging: { input: "metadata", output: "metadata" } },
    { name: "redacted", title: "Redacted", risk: "read-only", logging: { input: "redacted", output: "redacted" } },
    { name: "none", title: "None", risk: "read-only", logging: { input: "none", output: "none" } },
    { name: "unknown", title: "Unknown", risk: "read-only", logging: { input: "unknown" as never, output: "unknown" as never } },
    { name: "secret", title: "Secret", risk: "read-only", logging: { input: "full", output: "full" } },
    { name: "split", title: "Split", risk: "read-only", logging: { input: "full", output: "none" } },
  ];
  const plugin = createLoggingTestPlugin("logging-test", tools);
  const logs: Array<{
    event: string;
    fields: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  const manager: McpConfigManager = {
    pluginId: plugin.id,
    getSnapshot: () => ({
      pluginId: plugin.id,
      fields: [],
      values: {},
      revision: 0,
      updatedAt: null,
    }),
    update: async () => { throw new Error("not used"); },
    reload: async () => { throw new Error("not used"); },
    redactSecrets: (value) => redactTestSecret(value, secret),
  };
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "logging-test",
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
    mounts: [{ path: "/logging-test/mcp", plugin }],
    configManagers: [manager],
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  const endpoint = new URL("/logging-test/mcp", url);
  await callLoggingTool(endpoint, "full", "visible-full-value");
  await callLoggingTool(endpoint, "metadata", "hidden-metadata-value");
  await callLoggingTool(endpoint, "redacted", "hidden-redacted-value");
  await callLoggingTool(endpoint, "none", "hidden-none-value");
  await callLoggingTool(endpoint, "unknown", "hidden-unknown-value");
  await callLoggingTool(endpoint, "split", "visible-input-only");
  const secretResponse = await callLoggingTool(endpoint, "secret", secret);
  assert.match(secretResponse, new RegExp(secret));
  await callLoggingTool(endpoint, "metadata", "metadata-value", { rpcId: secret });

  const entries = (tool: string, event: string) => logs.filter(
    (entry) => entry.event === event && entry.fields?.tool === tool,
  );
  assert.match(JSON.stringify(entries("full", "mcp.request")), /visible-full-value/);
  assert.match(JSON.stringify(entries("full", "mcp.response")), /visible-full-value/);

  for (const event of ["mcp.request", "mcp.response"]) {
    const metadataEntry = entries("metadata", event)[0];
    assert.ok(metadataEntry);
    assert.equal(metadataEntry.fields?.input, undefined);
    assert.equal(metadataEntry.fields?.output, undefined);

    const redactedEntry = entries("redacted", event)[0];
    assert.ok(redactedEntry);
    assert.equal(redactedEntry.fields?.[event === "mcp.request" ? "input" : "output"], "[REDACTED]");

    const unknownEntry = entries("unknown", event)[0];
    assert.ok(unknownEntry);
    assert.equal(unknownEntry.fields?.input, undefined);
    assert.equal(unknownEntry.fields?.output, undefined);
  }
  assert.equal(entries("none", "mcp.request").length, 0);
  assert.equal(entries("none", "mcp.response").length, 0);
  assert.match(JSON.stringify(entries("split", "mcp.request")), /visible-input-only/);
  assert.equal(entries("split", "mcp.response").length, 0);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret));
  assert.ok(entries("metadata", "mcp.request").some(
    (entry) => entry.fields?.rpc_id === "[REDACTED]",
  ));
  assert.match(JSON.stringify(entries("secret", "mcp.request")), /\[REDACTED\]/);
  assert.match(JSON.stringify(entries("secret", "mcp.response")), /\[REDACTED\]/);

  const statusResponse = await fetch(new URL("/api/status", url));
  const status = await statusResponse.json() as {
    endpoints: Array<{ id: string; tools: PersonalMcpPlugin["tools"] }>;
  };
  const statusTool = status.endpoints[0]?.tools.find((candidate) => candidate.name === "split");
  assert.deepEqual(statusTool?.logging, { input: "full", output: "none" });
});

test("full Tool logs truncate input and output without retaining partial output", async (context) => {
  const plugin = createLoggingTestPlugin("logging-limit", [{
    name: "full",
    title: "Full",
    risk: "read-only",
    logging: { input: "full", output: "full" },
  }]);
  const logs: Array<{
    event: string;
    fields: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "logging-limit",
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
    mounts: [{ path: "/logging-limit/mcp", plugin }],
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  await callLoggingTool(new URL("/logging-limit/mcp", url), "full", "x".repeat(50_100), {
    extraValue: "y".repeat(50_100),
  });

  const requestLog = logs.find((entry) => entry.event === "mcp.request");
  const responseLog = logs.find((entry) => entry.event === "mcp.response");
  assert.match(JSON.stringify(requestLog?.fields?.input), /\[truncated\]/);
  assert.equal(responseLog?.fields?.truncated, true);
  assert.equal(responseLog?.fields?.output, "[TRUNCATED]");
});

test("replaced Plugins apply their current Tool logging policies", async (context) => {
  const pluginId = "logging-replacement";
  const fullPlugin = createLoggingTestPlugin(pluginId, [{
    name: "echo",
    title: "Echo",
    risk: "read-only",
    logging: { input: "full", output: "full" },
  }]);
  const nonePlugin = createLoggingTestPlugin(pluginId, [{
    name: "echo",
    title: "Echo",
    risk: "read-only",
    logging: { input: "none", output: "none" },
  }]);
  const registry = new McpRegistry([{ path: `/${pluginId}/mcp`, plugin: fullPlugin }]);
  const logs: Array<{
    event: string;
    fields: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: pluginId,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
    registry,
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });
  const endpoint = new URL(`/${pluginId}/mcp`, url);

  await callLoggingTool(endpoint, "echo", "logged-before-replacement");
  registry.replace(pluginId, nonePlugin);
  await callLoggingTool(endpoint, "echo", "hidden-after-replacement");

  const logText = JSON.stringify(logs);
  assert.match(logText, /logged-before-replacement/);
  assert.doesNotMatch(logText, /hidden-after-replacement/);
  assert.equal(logs.filter((entry) => entry.event === "mcp.request").length, 1);
  assert.equal(logs.filter((entry) => entry.event === "mcp.response").length, 1);
});

test("logger failures do not change successful MCP responses", async (context) => {
  const plugin = createLoggingTestPlugin("logging-failure", [{
    name: "full",
    title: "Full",
    risk: "read-only",
    logging: { input: "full", output: "full" },
  }]);
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "logging-failure",
    logger: {
      info: () => { throw new Error("logger unavailable"); },
      error: () => { throw new Error("logger unavailable"); },
    },
    mounts: [{ path: "/logging-failure/mcp", plugin }],
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  const body = await callLoggingTool(
    new URL("/logging-failure/mcp", url),
    "full",
    "request-still-succeeds",
  );
  assert.match(body, /request-still-succeeds/);
});

function createLoggingTestPlugin(
  id: string,
  tools: PersonalMcpPlugin["tools"],
): PersonalMcpPlugin {
  return {
    id,
    displayName: "Logging Test",
    summary: "logging policy test plugin",
    category: { id: "test", name: "Test", description: "Test plugins" },
    tools,
    createServer: () => {
      const server = new McpServer({ name: `${id}-server`, version: "0.1.0" });
      for (const tool of tools) {
        server.registerTool(tool.name, {
          inputSchema: z.object({ value: z.string(), extraValue: z.string().optional() }),
        }, async ({ value, extraValue }) => ({
          content: [{ type: "text" as const, text: `${value}${extraValue ?? ""}` }],
        }));
      }
      return server;
    },
  };
}

async function callLoggingTool(
  endpoint: URL,
  tool: string,
  value: string,
  options: { readonly extraValue?: string; readonly rpcId?: string | number } = {},
): Promise<string> {
  const toolResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: options.rpcId ?? `${tool}-${value.length}`,
      method: "tools/call",
      params: {
        name: tool,
        arguments: {
          value,
          ...(options.extraValue === undefined ? {} : { extraValue: options.extraValue }),
        },
      },
    }),
  });
  assert.equal(toolResponse.status, 200);
  return toolResponse.text();
}

function redactTestSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.replaceAll(secret, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactTestSecret(item, secret));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactTestSecret(item, secret)]),
    );
  }
  return value;
}
