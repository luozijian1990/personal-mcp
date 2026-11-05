import type { PersonalMcpPluginDefinition } from "../../core/plugin.js";
import { createKafkaConfigManager } from "./config-manager.js";
import { loadKafkaConfig } from "./config.js";
import { createKafkaPlugin, KAFKA_PLUGIN_METADATA } from "./index.js";
export const KAFKA_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = {
  metadata: KAFKA_PLUGIN_METADATA, defaultPort: 3109,
  createPlugin: environment => createKafkaPlugin({ config: loadKafkaConfig(environment) }),
  createConfigManager: createKafkaConfigManager,
};
