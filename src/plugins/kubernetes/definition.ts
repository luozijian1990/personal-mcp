import type { PersonalMcpPluginDefinition } from "../../core/plugin.js";
import { createKubernetesConfigManager } from "./config-manager.js";
import { loadKubernetesPluginConfig } from "./config.js";
import { KUBERNETES_DEFAULT_PORT } from "./constants.js";
import { createKubernetesPlugin, KUBERNETES_PLUGIN_METADATA } from "./index.js";

export const KUBERNETES_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = {
  metadata: KUBERNETES_PLUGIN_METADATA,
  defaultPort: KUBERNETES_DEFAULT_PORT,
  createPlugin: (environment) => createKubernetesPlugin({
    config: loadKubernetesPluginConfig(environment),
  }),
  createConfigManager: createKubernetesConfigManager,
};
