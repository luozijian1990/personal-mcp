import type { PersonalMcpPlugin } from "./plugin.js";

export interface McpMount {
  readonly path: string;
  readonly plugin: PersonalMcpPlugin;
}

export class McpRegistry {
  private readonly entries = new Map<string, { readonly path: string; plugin: PersonalMcpPlugin }>();
  private readonly paths = new Set<string>();

  constructor(mounts: readonly McpMount[]) {
    for (const mount of mounts) {
      if (this.entries.has(mount.plugin.id)) {
        throw new Error(`Duplicate MCP plugin id: ${mount.plugin.id}`);
      }
      if (this.paths.has(mount.path)) {
        throw new Error(`Duplicate MCP mount path: ${mount.path}`);
      }
      const expectedPath = `/${mount.plugin.id}/mcp`;
      if (mount.path !== expectedPath) {
        throw new Error(
          `Invalid MCP mount path for ${mount.plugin.id}: expected ${expectedPath}, received ${mount.path}`,
        );
      }
      this.entries.set(mount.plugin.id, { path: mount.path, plugin: mount.plugin });
      this.paths.add(mount.path);
    }
  }

  list(): readonly McpMount[] {
    return [...this.entries.values()].map(({ path, plugin }) => ({ path, plugin }));
  }

  get(pluginId: string): McpMount | undefined {
    const entry = this.entries.get(pluginId);
    return entry === undefined ? undefined : { path: entry.path, plugin: entry.plugin };
  }

  replace(pluginId: string, plugin: PersonalMcpPlugin): void {
    const entry = this.entries.get(pluginId);
    if (entry === undefined) throw new Error(`Cannot replace unknown MCP plugin: ${pluginId}`);
    if (plugin.id !== pluginId) {
      throw new Error(`Cannot replace ${pluginId} with plugin ${plugin.id}`);
    }
    entry.plugin = plugin;
  }
}
