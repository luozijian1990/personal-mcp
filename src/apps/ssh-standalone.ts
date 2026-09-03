import { createHttpApp } from "../core/http-app.js";
import { readPort, startHttpServer } from "../core/start-http-server.js";
import { createSshPlugin } from "../plugins/ssh/index.js";

const host = "127.0.0.1";
const port = readPort(process.env.PORT, 3101);
const sshPlugin = createSshPlugin();
const app = createHttpApp({
  host,
  serviceName: "ssh-mcp-standalone",
  mounts: [{ path: "/mcp", plugin: sshPlugin }],
});

const { url } = await startHttpServer(app, host, port);
console.error(`standalone SSH MCP listening on ${url.href}`);
console.error(`SSH MCP endpoint: ${new URL("/mcp", url).href}`);
