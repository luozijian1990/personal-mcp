import type { PersonalMcpPluginDefinition, PersonalMcpProfileDefinition } from "../../core/plugin.js";
import { createElasticsearchConfigManager } from "./config-manager.js";
import { loadElasticsearchPluginConfig } from "./config.js";
import { ELASTICSEARCH_DEFAULT_PORT } from "./constants.js";
import { createElasticsearchPlugin, ELASTICSEARCH_PLUGIN_METADATA } from "./index.js";

export const ELASTICSEARCH_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = {
  metadata: ELASTICSEARCH_PLUGIN_METADATA,
  defaultPort: ELASTICSEARCH_DEFAULT_PORT,
  createPlugin: (environment) => createElasticsearchPlugin({
    config: loadElasticsearchPluginConfig(environment),
  }),
  createConfigManager: createElasticsearchConfigManager,
};

/** Deployment helper for an isolated Elasticsearch connection Profile. */
export function createElasticsearchProfileDefinition(profileId: string): PersonalMcpProfileDefinition {
  return {
    pluginId: ELASTICSEARCH_PLUGIN_METADATA.id,
    profileId,
    createPlugin: (environment) => createElasticsearchPlugin({
      config: loadElasticsearchPluginConfig(environment),
    }),
    createConfigManager: (store) => createElasticsearchConfigManager(store, profileId),
  };
}
