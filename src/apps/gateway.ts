import { fileURLToPath } from "node:url";

import { reportStartedPluginRuntime, startPluginRuntime } from "../core/plugin-runtime.js";
import { readPort } from "../core/start-http-server.js";
import { pluginDefinitions, pluginProfileDefinitions } from "../plugins/catalog.js";

const host = "127.0.0.1";
const port = readPort(process.env.PORT, 3100);
const uiDirectory = fileURLToPath(new URL("../../dist-ui", import.meta.url));
const runtime = await startPluginRuntime({
  serviceName: "personal-mcp-gateway",
  definitions: pluginDefinitions,
  profileDefinitions: pluginProfileDefinitions,
  port,
  uiDirectory,
});
reportStartedPluginRuntime("personal-mcp gateway", runtime);
