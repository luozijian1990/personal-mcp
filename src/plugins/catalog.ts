import type { PersonalMcpPluginDefinition } from "../core/plugin.js";
import { initializePluginCatalog } from "../core/plugin-catalog.js";
import type { RuntimeConfigStore } from "../core/runtime-config.js";
import { createMysqlConfigManager } from "./mysql/config-manager.js";
import { loadMysqlPluginConfig } from "./mysql/config.js";
import { createMysqlPlugin, MYSQL_PLUGIN_METADATA } from "./mysql/index.js";
import { createPrometheusConfigManager } from "./prometheus/config-manager.js";
import { loadPrometheusPluginConfig } from "./prometheus/config.js";
import { createPrometheusPlugin, PROMETHEUS_PLUGIN_METADATA } from "./prometheus/index.js";
import { createSshConfigManager } from "./ssh/config-manager.js";
import { loadSshPluginConfig } from "./ssh/config.js";
import { createSshPlugin, SSH_PLUGIN_METADATA } from "./ssh/index.js";

export const pluginDefinitions: readonly PersonalMcpPluginDefinition[] = [
  {
    metadata: SSH_PLUGIN_METADATA,
    createPlugin: (environment) => createSshPlugin({ config: loadSshPluginConfig(environment) }),
    createConfigManager: createSshConfigManager,
  },
  {
    metadata: PROMETHEUS_PLUGIN_METADATA,
    createPlugin: (environment) => createPrometheusPlugin({ config: loadPrometheusPluginConfig(environment) }),
    createConfigManager: createPrometheusConfigManager,
  },
  {
    metadata: MYSQL_PLUGIN_METADATA,
    createPlugin: (environment) => createMysqlPlugin({ config: loadMysqlPluginConfig(environment) }),
    createConfigManager: createMysqlConfigManager,
  },
];

export function initializeBuiltinPluginCatalog(
  store: RuntimeConfigStore,
  definitions: readonly PersonalMcpPluginDefinition[] = pluginDefinitions,
): ReturnType<typeof initializePluginCatalog> {
  return initializePluginCatalog(store, definitions);
}
