import { reportStartedPluginRuntime, startStandalonePlugin } from "../core/plugin-runtime.js";
import { SKYWALKING_PLUGIN_DEFINITION } from "../plugins/skywalking/definition.js";
const runtime = await startStandalonePlugin(SKYWALKING_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone SkyWalking MCP", runtime);
