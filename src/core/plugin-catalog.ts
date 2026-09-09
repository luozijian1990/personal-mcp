import type {
  McpConfigManager,
  PersonalMcpPlugin,
  PersonalMcpPluginDefinition,
  PersonalMcpProfile,
  PersonalMcpProfileDefinition,
} from "./plugin.js";
import {
  DEFAULT_PROFILE_ID,
  profileIdentityKey,
  runtimeProfileEnvironment,
  validateProfileId,
} from "./plugin-profile.js";
import type { RuntimeConfigStore } from "./runtime-config.js";

export interface PluginCatalog {
  readonly mounts: readonly {
    readonly path: string;
    readonly plugin: PersonalMcpPlugin;
  }[];
  readonly configManagers: readonly McpConfigManager[];
  /** Runtime configuration/health instances, including every implicit default Profile. */
  readonly profiles: readonly PersonalMcpProfile[];
}

export function initializePluginCatalog(
  store: RuntimeConfigStore,
  definitions: readonly PersonalMcpPluginDefinition[],
  profileDefinitions: readonly PersonalMcpProfileDefinition[] = [],
): PluginCatalog {
  const seen = new Set<string>();
  const configManagers: McpConfigManager[] = [];
  const profiles: PersonalMcpProfile[] = [];
  const plugins = definitions.map((definition) => {
    const { id } = definition.metadata;
    if (seen.has(id)) {
      throw new Error(`Duplicate MCP plugin definition id: ${id}`);
    }
    seen.add(id);
    const plugin = definition.createPlugin(store.environment());
    if (plugin.id !== id) {
      throw new Error(`Plugin definition ${id} created ${plugin.id}`);
    }
    if (plugin.displayName !== definition.metadata.displayName
      || plugin.summary !== definition.metadata.summary
      || plugin.category.id !== definition.metadata.category.id
      || plugin.category.name !== definition.metadata.category.name
      || plugin.category.description !== definition.metadata.category.description) {
      throw new Error(`Plugin definition metadata does not match runtime plugin: ${id}`);
    }
    const configManager = definition.createConfigManager?.(store);
    if (configManager !== undefined) {
      if (configManager.pluginId !== id) {
        throw new Error(`Plugin definition ${id} created configuration manager ${configManager.pluginId}`);
      }
      if ((configManager.profileId ?? DEFAULT_PROFILE_ID) !== DEFAULT_PROFILE_ID) {
        throw new Error(`Plugin definition ${id} default configuration manager must use the default Profile`);
      }
      configManagers.push(configManager);
    }
    profiles.push({
      pluginId: id,
      profileId: DEFAULT_PROFILE_ID,
      plugin,
      ...(configManager === undefined ? {} : { configManager }),
    });
    return plugin;
  });

  const profileKeys = new Set(profiles
    .map(({ pluginId, profileId }) => profileIdentityKey(pluginId, profileId)));
  for (const definition of profileDefinitions) {
    if (!seen.has(definition.pluginId)) {
      throw new Error(`Profile ${definition.profileId} references unknown Plugin ${definition.pluginId}`);
    }
    validateProfileId(definition.profileId);
    const key = profileIdentityKey(definition.pluginId, definition.profileId);
    if (profileKeys.has(key)) {
      throw new Error(`Duplicate MCP Profile: ${definition.pluginId}/${definition.profileId}`);
    }
    profileKeys.add(key);
    const manager = definition.createConfigManager?.(store);
    if (manager !== undefined
      && (manager.pluginId !== definition.pluginId || (manager.profileId ?? DEFAULT_PROFILE_ID) !== definition.profileId)) {
      throw new Error(
        `Profile ${definition.pluginId}/${definition.profileId} created mismatched configuration manager ${manager.pluginId}/${manager.profileId ?? DEFAULT_PROFILE_ID}`,
      );
    }
    const configKeys = definition.configKeys
      ?? manager?.getSnapshot().fields.map((field) => field.key)
      ?? [];
    const plugin = definition.createPlugin(runtimeProfileEnvironment(
      store.environment(),
      definition.pluginId,
      definition.profileId,
      configKeys,
    ));
    if (plugin.id !== definition.pluginId) {
      throw new Error(
        `Profile ${definition.pluginId}/${definition.profileId} created Plugin ${plugin.id}`,
      );
    }
    if (manager !== undefined) configManagers.push(manager);
    profiles.push({
      pluginId: definition.pluginId,
      profileId: definition.profileId,
      plugin,
      ...(manager === undefined ? {} : { configManager: manager }),
    });
  }
  return {
    mounts: plugins.map((plugin) => ({ path: `/${plugin.id}/mcp`, plugin })),
    configManagers,
    profiles,
  };
}
