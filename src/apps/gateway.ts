import { fileURLToPath } from "node:url";

import { createHttpApp } from "../core/http-app.js";
import { McpRegistry } from "../core/mcp-registry.js";
import { createRuntimeConfigStore } from "../core/runtime-config.js";
import { readPort, startHttpServer } from "../core/start-http-server.js";
import { createSshConfigManager } from "../plugins/ssh/config-manager.js";
import { loadSshPluginConfig } from "../plugins/ssh/config.js";
import { createSshPlugin } from "../plugins/ssh/index.js";
import { createPrometheusConfigManager } from "../plugins/prometheus/config-manager.js";
import { loadPrometheusPluginConfig } from "../plugins/prometheus/config.js";
import { createPrometheusPlugin } from "../plugins/prometheus/index.js";
import { createMysqlPlugin } from "../plugins/mysql/index.js";
import { loadMysqlPluginConfig } from "../plugins/mysql/config.js";
import { createMysqlConfigManager } from "../plugins/mysql/config-manager.js";

const host = "127.0.0.1";
const port = readPort(process.env.PORT, 3100);
const uiDirectory = fileURLToPath(new URL("../../dist-ui", import.meta.url));
const runtimeConfig = createRuntimeConfigStore();
const environment = runtimeConfig.environment();
const sshPlugin = createSshPlugin({ config: loadSshPluginConfig(environment) });
const prometheusPlugin = createPrometheusPlugin({ config: loadPrometheusPluginConfig(environment) });
const mysqlPlugin = createMysqlPlugin({ config: loadMysqlPluginConfig(environment) });
const registry = new McpRegistry([
  { path: "/ssh/mcp", plugin: sshPlugin },
  { path: "/prometheus/mcp", plugin: prometheusPlugin },
  { path: "/mysql/mcp", plugin: mysqlPlugin },
]);
const app = createHttpApp({
  host,
  serviceName: "personal-mcp-gateway",
  uiDirectory,
  registry,
  configManagers: [
    createSshConfigManager(runtimeConfig),
    createPrometheusConfigManager(runtimeConfig),
    createMysqlConfigManager(runtimeConfig),
  ],
});

const { url } = await startHttpServer(app, host, port);
console.error(`personal-mcp gateway listening on ${url.href}`);
console.error(`SSH MCP endpoint: ${new URL("/ssh/mcp", url).href}`);
console.error(`Prometheus MCP endpoint: ${new URL("/prometheus/mcp", url).href}`);
console.error(`MySQL MCP endpoint: ${new URL("/mysql/mcp", url).href}`);
