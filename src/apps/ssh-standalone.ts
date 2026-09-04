import { createHttpApp } from "../core/http-app.js";
import { createRuntimeConfigStore } from "../core/runtime-config.js";
import { readPort, startHttpServer } from "../core/start-http-server.js";
import { loadSshPluginConfig } from "../plugins/ssh/config.js";
import { createSshPlugin } from "../plugins/ssh/index.js";

const host = "127.0.0.1";
const port = readPort(process.env.PORT, 3101);
const runtimeConfig = createRuntimeConfigStore();
const sshPlugin = createSshPlugin({ config: loadSshPluginConfig(runtimeConfig.environment()) });
const app = createHttpApp({
  host,
  serviceName: "ssh-mcp-standalone",
  mounts: [{ path: "/ssh/mcp", plugin: sshPlugin }],
});

const { url } = await startHttpServer(app, host, port);
console.error(`standalone SSH MCP listening on ${url.href}`);
console.error(`SSH MCP endpoint: ${new URL("/ssh/mcp", url).href}`);
