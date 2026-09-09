import { reportStartedPluginRuntime, startStandalonePlugin } from "../core/plugin-runtime.js";
import { JENKINS_PLUGIN_DEFINITION } from "../plugins/jenkins/definition.js";
const runtime = await startStandalonePlugin(JENKINS_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone Jenkins MCP", runtime);
