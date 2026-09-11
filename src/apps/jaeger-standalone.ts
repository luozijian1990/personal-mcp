import { reportStartedPluginRuntime, startStandalonePlugin } from "../core/plugin-runtime.js";
import { JAEGER_PLUGIN_DEFINITION } from "../plugins/jaeger/definition.js";
const runtime = await startStandalonePlugin(JAEGER_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone Jaeger MCP", runtime);
