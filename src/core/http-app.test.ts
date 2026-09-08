import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
    defaultValue: "",
    secret: true,
  }];
  const serverSource = createSshPlugin({
    config: { allowedTargets: new Set(), allowCommands: false, ports: [] },
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
  assert.doesNotMatch(statusText, /old-secret/);
  assert.match(statusText, /"TOKEN":\{"configured":true\}/);

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
