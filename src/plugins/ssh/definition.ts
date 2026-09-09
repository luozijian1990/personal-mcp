import type { PersonalMcpPluginDefinition } from "../../core/plugin.js";
import { createSshConfigManager } from "./config-manager.js";
import { loadSshPluginConfig } from "./config.js";
import { createSshPlugin, SSH_PLUGIN_METADATA } from "./index.js";

export const SSH_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = {
  metadata: SSH_PLUGIN_METADATA,
  defaultPort: 3101,
  createPlugin: (environment) => createSshPlugin({ config: loadSshPluginConfig(environment) }),
  createConfigManager: createSshConfigManager,
};
