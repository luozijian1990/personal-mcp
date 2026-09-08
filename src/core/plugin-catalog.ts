import type {
  McpConfigManager,
  PersonalMcpPlugin,
  PersonalMcpPluginDefinition,
} from "./plugin.js";
import type { RuntimeConfigStore } from "./runtime-config.js";

export interface PluginCatalog {
  readonly mounts: readonly {
    readonly path: string;
    readonly plugin: PersonalMcpPlugin;
  }[];
  readonly configManagers: readonly McpConfigManager[];
}

export function initializePluginCatalog(
  store: RuntimeConfigStore,
  definitions: readonly PersonalMcpPluginDefinition[],
): PluginCatalog {
  const seen = new Set<string>();
  const configManagers: McpConfigManager[] = [];
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
    if (definition.createConfigManager !== undefined) {
      const manager = definition.createConfigManager(store);
      if (manager.pluginId !== id) {
        throw new Error(`Plugin definition ${id} created configuration manager ${manager.pluginId}`);
      }
      configManagers.push(manager);
    }
    return plugin;
  });
  return {
    mounts: plugins.map((plugin) => ({ path: `/${plugin.id}/mcp`, plugin })),
    configManagers,
  };
}
