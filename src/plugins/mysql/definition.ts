import type { PersonalMcpPluginDefinition } from "../../core/plugin.js";
import { createMysqlConfigManager } from "./config-manager.js";
import { loadMysqlPluginConfig } from "./config.js";
import { createMysqlPlugin, MYSQL_PLUGIN_METADATA } from "./index.js";

export const MYSQL_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = {
  metadata: MYSQL_PLUGIN_METADATA,
  defaultPort: 3103,
  createPlugin: (environment) => createMysqlPlugin({ config: loadMysqlPluginConfig(environment) }),
  createConfigManager: createMysqlConfigManager,
};
