import {
  reportStartedPluginRuntime,
  startStandalonePlugin,
} from "../core/plugin-runtime.js";
import { KUBERNETES_PLUGIN_DEFINITION } from "../plugins/kubernetes/definition.js";

const runtime = await startStandalonePlugin(KUBERNETES_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone Kubernetes MCP", runtime);
