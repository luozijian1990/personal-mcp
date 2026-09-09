import { reportStartedPluginRuntime, startStandalonePlugin } from "../core/plugin-runtime.js";
import { SSH_PLUGIN_DEFINITION } from "../plugins/catalog.js";

const runtime = await startStandalonePlugin(SSH_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone SSH MCP", runtime);
