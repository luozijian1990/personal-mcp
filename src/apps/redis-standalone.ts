import { reportStartedPluginRuntime, startStandalonePlugin } from "../core/plugin-runtime.js";
import { REDIS_PLUGIN_DEFINITION } from "../plugins/redis/definition.js";

const runtime = await startStandalonePlugin(REDIS_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone Redis MCP", runtime);
