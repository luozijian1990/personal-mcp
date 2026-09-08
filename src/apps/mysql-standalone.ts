import { createHttpApp } from "../core/http-app.js";
import { createRuntimeConfigStore } from "../core/runtime-config.js";
import { loadMysqlPluginConfig } from "../plugins/mysql/config.js";
import { createMysqlPlugin } from "../plugins/mysql/index.js";
import { readPort, startHttpServer } from "../core/start-http-server.js";

const host = "127.0.0.1";
const port = readPort(process.env.PORT, 3103);
const runtimeConfig = createRuntimeConfigStore();
const plugin = createMysqlPlugin({ config: loadMysqlPluginConfig(runtimeConfig.environment()) });
const app = createHttpApp({ host, serviceName: "mysql-mcp-standalone", mounts: [{ path: "/mysql/mcp", plugin }] });
const { url } = await startHttpServer(app, host, port);
console.error(`standalone MySQL MCP listening on ${url.href}`);
console.error(`MySQL MCP endpoint: ${new URL("/mysql/mcp", url).href}`);
