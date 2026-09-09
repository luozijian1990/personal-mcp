import { fileURLToPath } from "node:url";

import { createHttpApp } from "../core/http-app.js";
import { McpRegistry } from "../core/mcp-registry.js";
import { createRuntimeConfigStore } from "../core/runtime-config.js";
import { readPort, startHttpServer } from "../core/start-http-server.js";
import { initializeBuiltinPluginCatalog } from "../plugins/catalog.js";

const host = "127.0.0.1";
const port = readPort(process.env.PORT, 3100);
const uiDirectory = fileURLToPath(new URL("../../dist-ui", import.meta.url));
const runtimeConfig = createRuntimeConfigStore();
const catalog = initializeBuiltinPluginCatalog(runtimeConfig);
const registry = new McpRegistry(catalog.mounts);
const app = createHttpApp({
  host,
  serviceName: "personal-mcp-gateway",
  uiDirectory,
  registry,
  profiles: catalog.profiles,
});

const { url } = await startHttpServer(app, host, port);
console.error(`personal-mcp gateway listening on ${url.href}`);
console.error(`SSH MCP endpoint: ${new URL("/ssh/mcp", url).href}`);
console.error(`Prometheus MCP endpoint: ${new URL("/prometheus/mcp", url).href}`);
console.error(`MySQL MCP endpoint: ${new URL("/mysql/mcp", url).href}`);
