import type { McpServer } from "@modelcontextprotocol/server";

export type PluginConfigValue = string | boolean;

export interface PluginConfigField {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly type: "text" | "boolean";
  readonly defaultValue: PluginConfigValue;
  readonly required?: boolean;
  readonly dangerous?: boolean;
}

export interface PluginConfigSnapshot {
  readonly pluginId: string;
  readonly fields: readonly PluginConfigField[];
  readonly values: Readonly<Record<string, PluginConfigValue>>;
  readonly revision: number;
  readonly updatedAt: string | null;
}

export interface PluginConfigUpdate {
  readonly plugin: PersonalMcpPlugin;
  readonly snapshot: PluginConfigSnapshot;
  readonly changedKeys: readonly string[];
}

export interface McpConfigManager {
  readonly pluginId: string;
  getSnapshot(): PluginConfigSnapshot;
  update(input: unknown): Promise<PluginConfigUpdate>;
  reload(): Promise<PluginConfigUpdate>;
}

export interface PersonalMcpPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly summary: string;
  readonly category: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  };
  readonly tools: readonly {
    readonly name: string;
    readonly title: string;
    readonly risk: "read-only" | "write-capable";
  }[];
  readonly config?: {
    readonly fields: readonly PluginConfigField[];
  };
  createServer(): McpServer;
}
