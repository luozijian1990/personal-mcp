import { fileURLToPath } from "node:url";

import { createHttpApp } from "../core/http-app.js";
import { readPort, startHttpServer } from "../core/start-http-server.js";
import { createSshPlugin } from "../plugins/ssh/index.js";

const host = "127.0.0.1";
const port = readPort(process.env.PORT, 3100);
const uiDirectory = fileURLToPath(new URL("../../dist-ui", import.meta.url));
const sshPlugin = createSshPlugin();
const app = createHttpApp({
  host,
  serviceName: "personal-mcp-gateway",
  uiDirectory,
  mounts: [{ path: "/mcp/ssh", plugin: sshPlugin }],
});

const { url } = await startHttpServer(app, host, port);
console.error(`personal-mcp gateway listening on ${url.href}`);
console.error(`SSH MCP endpoint: ${new URL("/mcp/ssh", url).href}`);
