import { reportStartedPluginRuntime, startStandalonePlugin } from "../core/plugin-runtime.js";
import { PROMETHEUS_PLUGIN_DEFINITION } from "../plugins/prometheus/definition.js";

const runtime = await startStandalonePlugin(PROMETHEUS_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone Prometheus MCP", runtime);
