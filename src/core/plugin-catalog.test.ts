import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { createHttpApp } from "./http-app.js";
import { McpRegistry } from "./mcp-registry.js";
import {
  createGenericConfigManager,
  type PersonalMcpPlugin,
  type PersonalMcpPluginDefinition,
  type PersonalMcpProfileDefinition,
  type PluginConfigField,
  type PluginConfigValue,
} from "./plugin.js";
import { runtimeProfileConfigKey } from "./plugin-profile.js";
import { startStandalonePlugin } from "./plugin-runtime.js";
import { createRuntimeConfigStore } from "./runtime-config.js";
import type { RuntimeConfigStore } from "./runtime-config.js";
import { startHttpServer } from "./start-http-server.js";
import { initializePluginCatalog } from "./plugin-catalog.js";
import {
  initializeBuiltinPluginCatalog,
  MYSQL_PLUGIN_DEFINITION,
  PROMETHEUS_PLUGIN_DEFINITION,
  SSH_PLUGIN_DEFINITION,
} from "../plugins/catalog.js";

function testPlugin(id: string): PersonalMcpPlugin {
  return {
    id,
    displayName: `Test ${id}`,
    summary: "replaceable test plugin",
    category: { id: "test", name: "Test", description: "Test plugins" },
    tools: [{ name: "ping", title: "Ping", risk: "read-only" }],
    createServer: () => {
      const server = new McpServer({ name: `${id}-server`, version: "1.0.0" });
      server.registerTool(
        "ping",
        { inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text", text: "pong" }] }),
      );
      return server;
    },
  };
}

const definition: PersonalMcpPluginDefinition = {
  metadata: {
    id: "test",
    displayName: "Test test",
    summary: "replaceable test plugin",
    category: { id: "test", name: "Test", description: "Test plugins" },
  },
  defaultPort: 3199,
  createPlugin: () => testPlugin("test"),
};

test("catalog initializes definitions into canonical mounts and registry", () => {
  const catalog = initializePluginCatalog(createRuntimeConfigStore(), [definition]);
  const registry = new McpRegistry(catalog.mounts);
  assert.equal(registry.get("test")?.path, "/test/mcp");
  assert.equal(registry.get("test")?.plugin, catalog.mounts[0]?.plugin);
});

test("catalog rejects duplicate definition ids", () => {
  assert.throws(
    () => initializePluginCatalog(createRuntimeConfigStore(), [definition, definition]),
    /Duplicate MCP plugin definition id: test/,
  );
});

test("catalog rejects mismatched runtime metadata and configuration wiring", () => {
  assert.throws(
    () => initializePluginCatalog(createRuntimeConfigStore(), [{
      ...definition,
      metadata: { ...definition.metadata, summary: "different" },
    }]),
    /metadata does not match runtime plugin/,
  );
  assert.throws(
    () => initializePluginCatalog(createRuntimeConfigStore(), [{
      ...definition,
      createConfigManager: () => ({
        pluginId: "other",
        getSnapshot: () => ({
          pluginId: "other",
          fields: [],
          values: {},
          revision: 0,
          updatedAt: null,
        }),
        update: async () => { throw new Error("not used"); },
        reload: async () => { throw new Error("not used"); },
      }),
    }]),
    /created configuration manager other/,
  );
});

test("a catalog test plugin is served through the runtime seam", async (context) => {
  const catalog = initializePluginCatalog(createRuntimeConfigStore(), [definition]);
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "catalog-test",
    logger: { info: () => undefined, error: () => undefined },
    mounts: catalog.mounts,
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });
  const response = await fetch(new URL("/test/mcp", url), {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ping/);
});

test("standalone startup reuses the catalog Runtime and respects its Definition port contract", async (context) => {
  const runtime = await startStandalonePlugin(definition, {
    port: 0,
    store: memoryConfigStore({}),
    logger: { info: () => undefined, error: () => undefined },
  });
  context.after(async () => {
    runtime.server.close();
    await once(runtime.server, "close");
  });

  assert.equal(definition.defaultPort, 3199);
  assert.deepEqual(runtime.catalog.mounts.map(({ path }) => path), ["/test/mcp"]);
  const response = await fetch(new URL("/test/mcp", runtime.url), {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ping/);
});

test("the test plugin can be replaced through the initialized registry", () => {
  const catalog = initializePluginCatalog(createRuntimeConfigStore(), [definition]);
  const registry = new McpRegistry(catalog.mounts);
  const replacement = { ...testPlugin("test"), summary: "replacement" };
  registry.replace("test", replacement);
  assert.equal(registry.get("test")?.plugin, replacement);
  assert.equal(registry.get("test")?.path, "/test/mcp");
});

test("the built-in catalog preserves plugin endpoints and status metadata", async (context) => {
  const catalog = initializeBuiltinPluginCatalog(createRuntimeConfigStore());
  assert.deepEqual(
    [SSH_PLUGIN_DEFINITION, PROMETHEUS_PLUGIN_DEFINITION, MYSQL_PLUGIN_DEFINITION]
      .map(({ metadata, defaultPort }) => ({ id: metadata.id, defaultPort })),
    [
      { id: "ssh", defaultPort: 3101 },
      { id: "prometheus", defaultPort: 3102 },
      { id: "mysql", defaultPort: 3103 },
    ],
  );
  assert.deepEqual(
    catalog.mounts.map(({ path, plugin }) => ({ id: plugin.id, path })),
    [
      { id: "ssh", path: "/ssh/mcp" },
      { id: "prometheus", path: "/prometheus/mcp" },
      { id: "mysql", path: "/mysql/mcp" },
    ],
  );
  assert.deepEqual(catalog.configManagers.map(({ pluginId }) => pluginId), ["ssh", "prometheus", "mysql"]);
  assert.deepEqual(
    catalog.profiles.map(({ pluginId, profileId }) => ({ pluginId, profileId })),
    [
      { pluginId: "ssh", profileId: "default" },
      { pluginId: "prometheus", profileId: "default" },
      { pluginId: "mysql", profileId: "default" },
    ],
  );

  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "catalog-test",
    logger: { info: () => undefined, error: () => undefined },
    registry: new McpRegistry(catalog.mounts),
    configManagers: catalog.configManagers,
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });
  const response = await fetch(new URL("/api/status", url));
  const body = await response.json() as {
    endpoints: Array<{ id: string; name: string; summary: string; category: { id: string }; path: string }>;
  };
  assert.equal(response.status, 200);
  assert.deepEqual(body.endpoints.map(({ id, path }) => ({ id, path })), [
    { id: "ssh", path: "/ssh/mcp" },
    { id: "prometheus", path: "/prometheus/mcp" },
    { id: "mysql", path: "/mysql/mcp" },
  ]);
  assert.deepEqual(body.endpoints.map(({ id, name, category }) => ({ id, name, category: category.id })), [
    { id: "ssh", name: "SSH Remote Operations", category: "remote-operations" },
    { id: "prometheus", name: "Prometheus Metrics", category: "observability" },
    { id: "mysql", name: "MySQL Database", category: "databases" },
  ]);
  assert.deepEqual(
    catalog.mounts.map(({ plugin }) => ({ id: plugin.id, tools: plugin.tools.map(({ name }) => name) })),
    [
      { id: "ssh", tools: ["ssh_get_system_snapshot", "ssh_execute_command"] },
      { id: "prometheus", tools: ["prometheus_query", "prometheus_query_range"] },
      { id: "mysql", tools: ["execute_sql"] },
    ],
  );
});

test("a Mock Plugin supports multiple Profile config lifecycles and health without changing Tool input", async (context) => {
  const store = memoryConfigStore({
    TEST_VALUE: "default-v1",
    TEST_FALLBACK: "default-only",
    [runtimeProfileConfigKey("multi", "prod", "TEST_VALUE")]: "prod-v1",
  });
  const mockDefinition: PersonalMcpPluginDefinition = {
    metadata: {
      id: "multi",
      displayName: "Multi Profile Test",
      summary: "Runtime Profile integration test",
      category: { id: "test", name: "Test", description: "Test Plugins" },
    },
    defaultPort: 3198,
    createPlugin: (environment) => multiProfilePlugin(
      environment.TEST_VALUE ?? "",
      environment.TEST_FALLBACK ?? "",
    ),
    createConfigManager: (runtimeStore) => multiProfileManager(
      runtimeStore,
      "default",
    ),
  };
  const prodProfile: PersonalMcpProfileDefinition = {
    pluginId: "multi",
    profileId: "prod",
    createPlugin: (environment) => multiProfilePlugin(
      environment.TEST_VALUE ?? "",
      environment.TEST_FALLBACK ?? "",
    ),
    createConfigManager: (runtimeStore) => multiProfileManager(
      runtimeStore,
      "prod",
    ),
  };
  const catalog = initializePluginCatalog(store, [mockDefinition], [prodProfile]);
  const registry = new McpRegistry(catalog.mounts);
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "profile-test",
    logger: { info: () => undefined, error: () => undefined },
    registry,
    profiles: catalog.profiles,
  });
  const { server, url } = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  assert.deepEqual(
    catalog.profiles.map(({ pluginId, profileId, configManager }) => ({
      pluginId,
      profileId,
      managerProfileId: configManager?.profileId,
    })),
    [
      { pluginId: "multi", profileId: "default", managerProfileId: "default" },
      { pluginId: "multi", profileId: "prod", managerProfileId: "prod" },
    ],
  );

  const initialStatus = await (await fetch(new URL("/api/status", url))).json() as {
    endpoints: Array<{
      id: string;
      health: { state: string; message?: string };
      profiles: Array<{ id: string; configurable: boolean; health: { state: string; message?: string } }>;
    }>;
    configs: Array<{ pluginId: string; profileId: string; values: Record<string, PluginConfigValue> }>;
  };
  assert.deepEqual(initialStatus.endpoints[0]?.profiles.map(({ id, configurable, health }) => ({
    id,
    configurable,
    state: health.state,
    message: health.message,
  })), [
    { id: "default", configurable: true, state: "healthy", message: "default-v1:default-only" },
    { id: "prod", configurable: true, state: "healthy", message: "prod-v1:unset" },
  ]);
  assert.equal(initialStatus.endpoints[0]?.health.message, "default-v1:default-only");
  assert.deepEqual(initialStatus.configs.map(({ pluginId, profileId }) => ({ pluginId, profileId })), [
    { pluginId: "multi", profileId: "default" },
    { pluginId: "multi", profileId: "prod" },
  ]);

  const update = await fetch(new URL("/api/config/multi/profiles/prod", url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { TEST_VALUE: "prod-v2" } }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json() as { config: { profileId: string; revision: number } }).config.profileId, "prod");
  assert.equal(store.environment().TEST_VALUE, "default-v1");
  assert.equal(
    store.environment()[runtimeProfileConfigKey("multi", "prod", "TEST_VALUE")],
    "prod-v2",
  );

  await store.update({ [runtimeProfileConfigKey("multi", "prod", "TEST_VALUE")]: "prod-v3" });
  const reload = await fetch(new URL("/api/config/multi/profiles/prod/reload", url), { method: "POST" });
  assert.equal(reload.status, 200);
  const reloaded = await reload.json() as { config: { profileId: string; revision: number; values: Record<string, string> } };
  assert.equal(reloaded.config.profileId, "prod");
  assert.equal(reloaded.config.revision, 2);
  assert.equal(reloaded.config.values.TEST_VALUE, "prod-v3");

  const finalStatus = await (await fetch(new URL("/api/status", url))).json() as {
    endpoints: Array<{ profiles: Array<{ id: string; health: { message?: string } }> }>;
  };
  assert.equal(
    finalStatus.endpoints[0]?.profiles.find(({ id }) => id === "prod")?.health.message,
    "prod-v3:unset",
  );

  const toolResponse = await fetch(new URL("/multi/mcp", url), {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
  });
  const toolBody = await toolResponse.text();
  assert.equal(toolResponse.status, 200);
  assert.match(toolBody, /default-v1:default-only/);
  assert.doesNotMatch(toolBody, /profile/);
});

test("Profile persistence keys cannot collide across Plugin/Profile boundaries", () => {
  assert.notEqual(
    runtimeProfileConfigKey("a", "b__c", "TOKEN"),
    runtimeProfileConfigKey("a__b", "c", "TOKEN"),
  );
});

function multiProfilePlugin(value: string, fallback: string): PersonalMcpPlugin {
  const description = `${value}:${fallback || "unset"}`;
  return {
    id: "multi",
    displayName: "Multi Profile Test",
    summary: "Runtime Profile integration test",
    category: { id: "test", name: "Test", description: "Test Plugins" },
    tools: [{ name: "ping", title: "Ping", risk: "read-only" }],
    checkHealth: async () => ({
      state: value.length > 0 ? "healthy" : "unconfigured",
      message: description,
    }),
    createServer: () => {
      const server = new McpServer({ name: "multi-profile-test", version: "1.0.0" });
      server.registerTool(
        "ping",
        { inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text", text: description }] }),
      );
      return server;
    },
  };
}

function multiProfileManager(
  store: RuntimeConfigStore,
  profileId: string,
) {
  const fields: readonly PluginConfigField[] = [
    {
      key: "TEST_VALUE",
      label: "Value",
      description: "Profile value",
      type: "text",
      defaultValue: "",
    },
    {
      key: "TEST_FALLBACK",
      label: "Fallback",
      description: "Profile fallback",
      type: "text",
      defaultValue: "",
    },
  ];
  return createGenericConfigManager({
    pluginId: "multi",
    profileId,
    fields,
    store,
    load: (environment) => ({
      value: environment.TEST_VALUE ?? "",
      fallback: environment.TEST_FALLBACK ?? "",
    }),
    values: (config) => ({ TEST_VALUE: config.value, TEST_FALLBACK: config.fallback }),
    parse: (input, current) => {
      const raw = typeof input === "object" && input !== null && "values" in input
        ? (input as { values: Record<string, PluginConfigValue> }).values
        : input as Record<string, PluginConfigValue>;
      return { ...current, ...raw };
    },
    environment: (values, base) => ({
      ...base,
      TEST_VALUE: String(values.TEST_VALUE ?? ""),
      TEST_FALLBACK: String(values.TEST_FALLBACK ?? ""),
    }),
    persist: (values) => ({
      TEST_VALUE: String(values.TEST_VALUE ?? ""),
      TEST_FALLBACK: String(values.TEST_FALLBACK ?? ""),
    }),
    validate: () => undefined,
    createPlugin: (config) => multiProfilePlugin(config.value, config.fallback),
  });
}

function memoryConfigStore(initial: NodeJS.ProcessEnv): RuntimeConfigStore {
  let environment = { ...initial };
  return {
    environment: () => ({ ...environment }),
    update: async (values) => { environment = { ...environment, ...values }; },
  };
}
