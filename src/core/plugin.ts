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
  /** Secret keys are omitted from values; only their configured state is public. */
  readonly secretStates?: Readonly<Record<string, { readonly configured: boolean }>>;
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
  const loadCurrentValues = () => currentValues
    ?? options.values(options.load(options.store.environment()));
  const snapshot = (): PluginConfigSnapshot => {
    const values = loadCurrentValues();
    return {
      pluginId: options.pluginId,
      fields: options.fields,
      values: publicConfigValues(values, options.fields),
      secretStates: secretConfigStates(values, options.fields),
      revision,
      updatedAt,
    };
  };
  const run = async (input?: unknown, reload = false): Promise<PluginConfigUpdate> => {
    const beforeValues = loadCurrentValues();
    const base = options.store.environment();
    const secretCandidates = secretValuesForRedaction(beforeValues, input, options.fields);
    try {
      const parsedValues = reload
        ? options.values(options.load(base))
        : options.parse(input, beforeValues);
      const nextValues = reload
        ? parsedValues
        : applySecretUpdateSemantics(input, parsedValues, beforeValues, options.fields);
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
        .filter((key) => !configValuesEqual(beforeValues[key], currentValues?.[key])) };
    } catch (error) {
      throw redactSecretError(error, secretCandidates);
    }
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

function publicConfigValues(
  values: Readonly<Record<string, PluginConfigValue>>,
  fields: readonly PluginConfigField[],
): Readonly<Record<string, PluginConfigValue>> {
  const secretKeys = new Set(fields.filter((field) => field.secret).map((field) => field.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => !secretKeys.has(key)));
}

function secretConfigStates(
  values: Readonly<Record<string, PluginConfigValue>>,
  fields: readonly PluginConfigField[],
): Readonly<Record<string, { readonly configured: boolean }>> {
  return Object.fromEntries(fields.filter((field) => field.secret).map((field) => {
    const value = values[field.key];
    return [field.key, { configured: typeof value === "string" && value.length > 0 }];
  }));
}

function applySecretUpdateSemantics(
  input: unknown,
  parsed: Record<string, PluginConfigValue>,
  current: Readonly<Record<string, PluginConfigValue>>,
  fields: readonly PluginConfigField[],
): Record<string, PluginConfigValue> {
  const request = isRecord(input) ? input : {};
  const rawValues = isRecord(request.values) ? request.values : request;
  const clearSecrets = request.clearSecrets;
  if (clearSecrets !== undefined && (!Array.isArray(clearSecrets) || clearSecrets.some((key) => typeof key !== "string"))) {
    throw new Error("clearSecrets must be an array of Secret field keys");
  }
  const requestedClears = new Set((clearSecrets ?? []) as string[]);
  const secretKeys = new Set(fields.filter((field) => field.secret).map((field) => field.key));
  const unknownClears = [...requestedClears].filter((key) => !secretKeys.has(key));
  if (unknownClears.length > 0) {
    throw new Error(`Cannot clear non-Secret configuration field: ${unknownClears.join(", ")}`);
  }
  const next = { ...parsed };
  for (const key of secretKeys) {
    const supplied = Object.hasOwn(rawValues, key);
    const replacement = rawValues[key];
    if (requestedClears.has(key)) {
      if (supplied && typeof replacement === "string" && replacement.length > 0) {
        throw new Error(`Secret field ${key} cannot be replaced and cleared in the same update`);
      }
      next[key] = "";
    } else if (!supplied || replacement === "") {
      const existing = current[key];
      if (existing === undefined) delete next[key];
      else next[key] = existing;
    }
  }
  return next;
}

function secretValuesForRedaction(
  current: Readonly<Record<string, PluginConfigValue>>,
  input: unknown,
  fields: readonly PluginConfigField[],
): readonly string[] {
  const request = isRecord(input) ? input : {};
  const rawValues = isRecord(request.values) ? request.values : request;
  return [...new Set(fields.filter((field) => field.secret).flatMap((field) => {
    const candidates = [current[field.key], rawValues[field.key]];
    return candidates.filter((value): value is string => typeof value === "string" && value.length > 0);
  }))];
}

function redactSecretError(error: unknown, secrets: readonly string[]): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.replaceAll(secret, "[REDACTED]");
  return new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
