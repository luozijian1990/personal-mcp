import { createHttpApp } from "../core/http-app.js";
import { createRuntimeConfigStore } from "../core/runtime-config.js";
import { loadPrometheusPluginConfig } from "../plugins/prometheus/config.js";
import { createPrometheusPlugin } from "../plugins/prometheus/index.js";
import { readPort, startHttpServer } from "../core/start-http-server.js";

const host = "127.0.0.1";
const port = readPort(process.env.PORT, 3102);
const runtimeConfig = createRuntimeConfigStore();
const prometheusPlugin = createPrometheusPlugin({
  config: loadPrometheusPluginConfig(runtimeConfig.environment()),
});
const app = createHttpApp({
  host,
  serviceName: "prometheus-mcp-standalone",
  mounts: [{ path: "/prometheus/mcp", plugin: prometheusPlugin }],
});

const { url } = await startHttpServer(app, host, port);
console.error(`standalone Prometheus MCP listening on ${url.href}`);
console.error(`Prometheus MCP endpoint: ${new URL("/prometheus/mcp", url).href}`);

