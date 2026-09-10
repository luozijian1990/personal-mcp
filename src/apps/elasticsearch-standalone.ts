import {
  reportStartedPluginRuntime,
  startStandalonePlugin,
} from "../core/plugin-runtime.js";
import { ELASTICSEARCH_PLUGIN_DEFINITION } from "../plugins/elasticsearch/definition.js";

const runtime = await startStandalonePlugin(ELASTICSEARCH_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone Elasticsearch 7 MCP", runtime);
