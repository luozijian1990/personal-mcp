import type { PersonalMcpPluginDefinition } from "../../core/plugin.js";
import { createJaegerPlugin, JAEGER_PLUGIN_METADATA } from "./index.js";
import { loadJaegerPluginConfig } from "./config.js";
import { createJaegerConfigManager } from "./config-manager.js";

export const JAEGER_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = {
  metadata: JAEGER_PLUGIN_METADATA,
  defaultPort: 3107,
  createPlugin: environment => createJaegerPlugin(loadJaegerPluginConfig(environment)),
  createConfigManager: createJaegerConfigManager,
};
