import { reportStartedPluginRuntime, startStandalonePlugin } from "../core/plugin-runtime.js";
import { MYSQL_PLUGIN_DEFINITION } from "../plugins/catalog.js";

const runtime = await startStandalonePlugin(MYSQL_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone MySQL MCP", runtime);
