import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { createHttpApp } from "./http-app.js";
import { McpRegistry } from "./mcp-registry.js";
import type { PersonalMcpPlugin, PersonalMcpPluginDefinition } from "./plugin.js";
import { createRuntimeConfigStore } from "./runtime-config.js";
import { startHttpServer } from "./start-http-server.js";
import { initializePluginCatalog } from "./plugin-catalog.js";
import { initializeBuiltinPluginCatalog } from "../plugins/catalog.js";

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
    catalog.mounts.map(({ path, plugin }) => ({ id: plugin.id, path })),
    [
      { id: "ssh", path: "/ssh/mcp" },
      { id: "prometheus", path: "/prometheus/mcp" },
      { id: "mysql", path: "/mysql/mcp" },
    ],
  );
  assert.deepEqual(catalog.configManagers.map(({ pluginId }) => pluginId), ["ssh", "prometheus", "mysql"]);

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
});
