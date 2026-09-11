import type {
  PersonalMcpPluginDefinition,
  PersonalMcpProfileDefinition,
} from "../core/plugin.js";
import { initializePluginCatalog } from "../core/plugin-catalog.js";
import type { RuntimeConfigStore } from "../core/runtime-config.js";
import { MYSQL_PLUGIN_DEFINITION } from "./mysql/definition.js";
import { PROMETHEUS_PLUGIN_DEFINITION } from "./prometheus/definition.js";
import { SSH_PLUGIN_DEFINITION } from "./ssh/definition.js";
import { JENKINS_PLUGIN_DEFINITION } from "./jenkins/definition.js";
import { KUBERNETES_PLUGIN_DEFINITION } from "./kubernetes/definition.js";
import { ELASTICSEARCH_PLUGIN_DEFINITION } from "./elasticsearch/definition.js";
import { SKYWALKING_PLUGIN_DEFINITION } from "./skywalking/definition.js";

export const pluginDefinitions: readonly PersonalMcpPluginDefinition[] = [
  SSH_PLUGIN_DEFINITION,
  PROMETHEUS_PLUGIN_DEFINITION,
  MYSQL_PLUGIN_DEFINITION,
  JENKINS_PLUGIN_DEFINITION,
  KUBERNETES_PLUGIN_DEFINITION,
  ELASTICSEARCH_PLUGIN_DEFINITION,
  SKYWALKING_PLUGIN_DEFINITION,
];

/** Deployment-owned named Profiles registered alongside the built-in Plugin Definitions. */
export const pluginProfileDefinitions: readonly PersonalMcpProfileDefinition[] = [];

export function initializeBuiltinPluginCatalog(
  store: RuntimeConfigStore,
  definitions: readonly PersonalMcpPluginDefinition[] = pluginDefinitions,
  profileDefinitions: readonly PersonalMcpProfileDefinition[] = pluginProfileDefinitions,
): ReturnType<typeof initializePluginCatalog> {
  return initializePluginCatalog(store, definitions, profileDefinitions);
}
