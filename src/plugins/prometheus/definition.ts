import type { PersonalMcpPluginDefinition } from "../../core/plugin.js";
import { createPrometheusConfigManager } from "./config-manager.js";
import { loadPrometheusPluginConfig } from "./config.js";
import { createPrometheusPlugin, PROMETHEUS_PLUGIN_METADATA } from "./index.js";

export const PROMETHEUS_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = {
  metadata: PROMETHEUS_PLUGIN_METADATA,
  defaultPort: 3102,
  createPlugin: (environment) => createPrometheusPlugin({
    config: loadPrometheusPluginConfig(environment),
  }),
  createConfigManager: createPrometheusConfigManager,
};
