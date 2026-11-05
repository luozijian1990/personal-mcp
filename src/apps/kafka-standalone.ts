import { reportStartedPluginRuntime, startStandalonePlugin } from "../core/plugin-runtime.js";
import { KAFKA_PLUGIN_DEFINITION } from "../plugins/kafka/definition.js";
const runtime = await startStandalonePlugin(KAFKA_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone Kafka MCP", runtime);
