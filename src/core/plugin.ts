import type { McpServer } from "@modelcontextprotocol/server";
import type { RuntimeConfigStore, RuntimeConfigValues } from "./runtime-config.js";

export type PluginConfigValue = string | number | boolean | readonly string[];

export type PluginConfigFieldType =
  | "text"
  | "password"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "textarea"
  | "path";

export interface PluginConfigOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface PluginConfigGroup {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

interface PluginConfigFieldBase {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly required?: boolean;
  readonly dangerous?: boolean;
  readonly placeholder?: string;
  readonly group?: PluginConfigGroup;
}

export type PluginConfigField = PluginConfigFieldBase & (
  | {
    readonly type: "text" | "password" | "textarea" | "path";
    readonly defaultValue: string;
    readonly secret?: boolean;
    readonly options?: never;
  }
  | {
    readonly type: "number";
    readonly defaultValue: number;
    readonly secret?: never;
    readonly options?: never;
  }
  | {
    readonly type: "boolean";
    readonly defaultValue: boolean;
    readonly secret?: never;
    readonly options?: never;
  }
  | {
    readonly type: "select";
    readonly defaultValue: string;
    readonly secret?: never;
    readonly options: readonly [PluginConfigOption, ...PluginConfigOption[]];
  }
  | {
    readonly type: "multiselect";
    readonly defaultValue: readonly string[];
    readonly secret?: never;
    readonly options: readonly [PluginConfigOption, ...PluginConfigOption[]];
  }
);

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
  /** Runtime wires this to atomically replace the mounted instance after persistence succeeds. */
  setRuntimeReplacement?(replace: (plugin: PersonalMcpPlugin) => void): void;
}

/** Hooks used by plugins to provide parsing/validation while the framework owns lifecycle state. */
export interface GenericConfigLifecycleOptions<Config> {
  readonly pluginId: string;
  readonly fields: readonly PluginConfigField[];
  readonly store: RuntimeConfigStore;
  readonly load: (environment: NodeJS.ProcessEnv) => Config;
  readonly values: (config: Config) => Readonly<Record<string, PluginConfigValue>>;
  readonly parse: (input: unknown, current: Readonly<Record<string, PluginConfigValue>>) => Record<string, PluginConfigValue>;
  readonly environment: (values: Readonly<Record<string, PluginConfigValue>>, base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  readonly persist?: (values: Readonly<Record<string, PluginConfigValue>>, base: NodeJS.ProcessEnv) => RuntimeConfigValues;
  readonly validate: (config: Config) => void | Promise<void>;
  readonly createPlugin: (config: Config) => PersonalMcpPlugin;
}

export function createGenericConfigManager<Config>(
  options: GenericConfigLifecycleOptions<Config>,
): McpConfigManager {
  let revision = 0;
  let updatedAt: string | null = null;
  let currentPlugin: PersonalMcpPlugin | undefined;
  let replaceRuntime: ((plugin: PersonalMcpPlugin) => void) | undefined;
  let currentValues: Readonly<Record<string, PluginConfigValue>> | undefined;
  let operations = Promise.resolve();
  const snapshot = (): PluginConfigSnapshot => {
    const values = currentValues ?? options.values(options.load(options.store.environment()));
    return { pluginId: options.pluginId, fields: options.fields, values, revision, updatedAt };
  };
  const run = async (input?: unknown, reload = false): Promise<PluginConfigUpdate> => {
    const before = snapshot();
    const base = options.store.environment();
    const nextValues = reload
      ? options.values(options.load(base))
      : options.parse(input, before.values);
    const config = options.load(options.environment(nextValues, base));
    await options.validate(config);
    const plugin = options.createPlugin(config);
    if (!reload) {
      const nextEnvironment = options.environment(nextValues, base);
      const persisted = options.persist?.(nextValues, nextEnvironment)
        ?? Object.fromEntries(options.fields.map((field) => [field.key, nextEnvironment[field.key] ?? ""]));
      await options.store.update(persisted);
    }
    replaceRuntime?.(plugin);
    currentPlugin = plugin;
    currentValues = options.values(config);
    revision += 1;
    updatedAt = new Date().toISOString();
    const after = snapshot();
    return { plugin: currentPlugin, snapshot: after, changedKeys: options.fields
      .map((field) => field.key)
      .filter((key) => !configValuesEqual(before.values[key], after.values[key])) };
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  };
  return { pluginId: options.pluginId, getSnapshot: snapshot,
    setRuntimeReplacement: (replace) => { replaceRuntime = replace; },
    update: (input) => enqueue(() => run(input)), reload: () => enqueue(() => run(undefined, true)) };
}

function configValuesEqual(
  left: PluginConfigValue | undefined,
  right: PluginConfigValue | undefined,
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface PersonalMcpPluginMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly summary: string;
  readonly category: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  };
}

export type ToolRisk =
  | "read-only"
  | "write"
  | "destructive"
  | "privileged"
  /** @deprecated Compatibility alias for pre-risk-model plugins. Prefer `write`. */
  | "write-capable";

export interface PersonalMcpToolMetadata {
  readonly name: string;
  readonly title: string;
  readonly risk: ToolRisk;
  /** Interaction hint only. The MCP server must still enforce authorization and safety. */
  readonly requiresConfirmation?: boolean;
  /** Discovery/exposure hint only. The MCP server remains the authoritative safety boundary. */
  readonly disabledByDefault?: boolean;
}

export interface PersonalMcpPlugin extends PersonalMcpPluginMetadata {
  readonly tools: readonly PersonalMcpToolMetadata[];
  readonly config?: {
    readonly fields: readonly PluginConfigField[];
  };
  createServer(): McpServer;
}

/** Declarative registration plus the factories needed to create a runtime plugin. */
export interface PersonalMcpPluginDefinition {
  readonly metadata: PersonalMcpPluginMetadata;
  readonly createPlugin: (environment: NodeJS.ProcessEnv) => PersonalMcpPlugin;
  readonly createConfigManager?: (store: RuntimeConfigStore) => McpConfigManager;
}
