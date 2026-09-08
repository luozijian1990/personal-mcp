import type { McpServer } from "@modelcontextprotocol/server";
import type { RuntimeConfigStore, RuntimeConfigValues } from "./runtime-config.js";

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
  readonly parse: (input: unknown, current: Readonly<Record<string, PluginConfigValue>>) => Record<string, string | boolean>;
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
      .filter((key) => before.values[key] !== after.values[key]) };
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

export interface PersonalMcpPlugin extends PersonalMcpPluginMetadata {
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

/** Declarative registration plus the factories needed to create a runtime plugin. */
export interface PersonalMcpPluginDefinition {
  readonly metadata: PersonalMcpPluginMetadata;
  readonly createPlugin: (environment: NodeJS.ProcessEnv) => PersonalMcpPlugin;
  readonly createConfigManager?: (store: RuntimeConfigStore) => McpConfigManager;
}
