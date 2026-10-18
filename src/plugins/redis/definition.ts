import type { PersonalMcpPluginDefinition } from "../../core/plugin.js";
import { createRedisConfigManager } from "./config-manager.js";
import { loadRedisConfig } from "./config.js";
import { createRedisPlugin, REDIS_PLUGIN_METADATA } from "./index.js";

export const REDIS_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = {
  metadata: REDIS_PLUGIN_METADATA, defaultPort: 3108,
  createPlugin: environment => createRedisPlugin({ config: loadRedisConfig(environment) }),
  createConfigManager: createRedisConfigManager,
};
