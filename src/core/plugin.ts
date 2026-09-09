import type { McpServer } from "@modelcontextprotocol/server";
import type { RuntimeConfigStore, RuntimeConfigValues } from "./runtime-config.js";
import {
  DEFAULT_PROFILE_ID,
  runtimeProfileConfigValues,
  runtimeProfileEnvironment,
} from "./plugin-profile.js";

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
  /** Runtime profile that owns this configuration. Existing plugins use `default`. */
  readonly profileId?: string;
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
  readonly profileId?: string;
  getSnapshot(): PluginConfigSnapshot;
  update(input: unknown): Promise<PluginConfigUpdate>;
  reload(): Promise<PluginConfigUpdate>;
  /** Removes configured Secret values from data before it enters ordinary logs. */
  redactSecrets?(value: unknown): unknown;
  /** Runtime wires this to atomically replace the mounted instance after persistence succeeds. */
  setRuntimeReplacement?(replace: (plugin: PersonalMcpPlugin) => void): void;
}

/** Hooks used by plugins to provide parsing/validation while the framework owns lifecycle state. */
export interface GenericConfigLifecycleOptions<Config> {
  readonly pluginId: string;
  /** Optional runtime profile identifier; omitted means the implicit default profile. */
  readonly profileId?: string;
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
  const secretFields = options.fields.filter((field) => field.secret);
  const secretKeys = new Set(secretFields.map((field) => field.key));
  const publicFields = options.fields.map((field) => field.secret
    ? { ...field, defaultValue: "" }
    : field);
  let revision = 0;
  let updatedAt: string | null = null;
  let currentPlugin: PersonalMcpPlugin | undefined;
  let replaceRuntime: ((plugin: PersonalMcpPlugin) => void) | undefined;
  let currentPrivateValues: Readonly<Record<string, PluginConfigValue>> | undefined;
  let operations = Promise.resolve();
  const runtimeEnvironment = () => runtimeProfileEnvironment(
    options.store.environment(),
    options.pluginId,
    options.profileId ?? DEFAULT_PROFILE_ID,
    options.fields.map((field) => field.key),
  );
  const loadPrivateValues = (): Readonly<Record<string, PluginConfigValue>> => {
    if (currentPrivateValues !== undefined) return currentPrivateValues;
    try {
      return options.values(options.load(runtimeEnvironment()));
    } catch (error) {
      if (secretFields.length > 0) {
        throw new Error(`Unable to load configuration for ${options.pluginId}`);
      }
      throw error;
    }
  };
  const snapshot = (): PluginConfigSnapshot => {
    const privateValues = loadPrivateValues();
    return {
      pluginId: options.pluginId,
      profileId: options.profileId ?? DEFAULT_PROFILE_ID,
      fields: publicFields,
      values: publicConfigValues(privateValues, secretKeys),
      secretStates: secretConfigStates(privateValues, secretFields),
      revision,
      updatedAt,
    };
  };
  const run = async (input?: unknown, reload = false): Promise<PluginConfigUpdate> => {
    const beforePrivateValues = loadPrivateValues();
    const base = runtimeEnvironment();
    const secretCandidates = new Set(
      secretValuesForRedaction(beforePrivateValues, input, secretFields),
    );
    const beforeSecretValuesKnown = <T>(operation: () => T): T => {
      try {
        return operation();
      } catch (error) {
        if (secretFields.length > 0) {
          throw new Error(`Invalid configuration for ${options.pluginId}`);
        }
        throw error;
      }
    };
    try {
      const secretUpdate = reload
        ? undefined
        : createSecretUpdatePlan(input, beforePrivateValues, secretKeys);
      const parsedValues = beforeSecretValuesKnown(() => reload
        ? options.values(options.load(base))
        : options.parse(secretUpdate?.input, beforePrivateValues));
      addSecretValuesForRedaction(secretCandidates, parsedValues, secretFields);
      const nextValues = reload
        ? parsedValues
        : applySecretOverrides(parsedValues, secretUpdate?.overrides);
      const config = beforeSecretValuesKnown(
        () => options.load(options.environment(nextValues, base)),
      );
      addSecretValuesForRedaction(
        secretCandidates,
        beforeSecretValuesKnown(() => options.values(config)),
        secretFields,
      );
      await options.validate(config);
      const plugin = options.createPlugin(config);
      if (!reload) {
        const nextEnvironment = options.environment(nextValues, base);
        const persisted = options.persist?.(nextValues, nextEnvironment)
          ?? Object.fromEntries(options.fields.map((field) => [field.key, nextEnvironment[field.key] ?? ""]));
        await options.store.update(runtimeProfileConfigValues(
          persisted,
          options.pluginId,
          options.profileId ?? DEFAULT_PROFILE_ID,
        ));
      }
      replaceRuntime?.(plugin);
      currentPlugin = plugin;
      currentPrivateValues = options.values(config);
      revision += 1;
      updatedAt = new Date().toISOString();
      const after = snapshot();
      return { plugin: currentPlugin, snapshot: after, changedKeys: options.fields
        .map((field) => field.key)
        .filter((key) => !configValuesEqual(beforePrivateValues[key], currentPrivateValues?.[key])) };
    } catch (error) {
      throw redactSecretError(error, [...secretCandidates]);
    }
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  };
  return { pluginId: options.pluginId, profileId: options.profileId ?? DEFAULT_PROFILE_ID, getSnapshot: snapshot,
    redactSecrets: (value) => redactSecretData(
      value,
      secretValuesForRedaction(loadPrivateValues(), undefined, secretFields),
    ),
    setRuntimeReplacement: (replace) => { replaceRuntime = replace; },
    update: (input) => enqueue(() => run(input)), reload: () => enqueue(() => run(undefined, true)) };
}

function publicConfigValues(
  values: Readonly<Record<string, PluginConfigValue>>,
  secretKeys: ReadonlySet<string>,
): Readonly<Record<string, PluginConfigValue>> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !secretKeys.has(key)));
}

function secretConfigStates(
  values: Readonly<Record<string, PluginConfigValue>>,
  secretFields: readonly PluginConfigField[],
): Readonly<Record<string, { readonly configured: boolean }>> {
  return Object.fromEntries(secretFields.map((field) => {
    const value = values[field.key];
    return [field.key, { configured: typeof value === "string" && value.length > 0 }];
  }));
}

interface SecretUpdatePlan {
  readonly input: unknown;
  readonly overrides: ReadonlyMap<string, PluginConfigValue | undefined>;
}

function createSecretUpdatePlan(
  input: unknown,
  current: Readonly<Record<string, PluginConfigValue>>,
  secretKeys: ReadonlySet<string>,
): SecretUpdatePlan {
  if (!isRecord(input)) return { input, overrides: new Map() };
  const wrapped = isRecord(input.values);
  const rawValues = wrapped ? input.values as Record<string, unknown> : input;
  const requestedClears = readRequestedSecretClears(input, secretKeys);
  const preparedValues: Record<string, unknown> = { ...rawValues };
  const overrides = new Map<string, PluginConfigValue | undefined>();
  if (!wrapped) delete preparedValues.clearSecrets;
  for (const key of secretKeys) {
    const supplied = Object.hasOwn(rawValues, key);
    const replacement = rawValues[key];
    if (requestedClears.has(key)) {
      if (supplied && typeof replacement === "string" && replacement.length > 0) {
        throw new Error(`Secret field ${key} cannot be replaced and cleared in the same update`);
      }
      overrides.set(key, "");
    } else if (!supplied || replacement === "") {
      overrides.set(key, current[key]);
    }
  }
  for (const [key, value] of overrides) {
    if (value === undefined) delete preparedValues[key];
    else preparedValues[key] = value;
  }
  return {
    input: wrapped ? { ...input, values: preparedValues } : preparedValues,
    overrides,
  };
}

function applySecretOverrides(
  parsed: Record<string, PluginConfigValue>,
  overrides: ReadonlyMap<string, PluginConfigValue | undefined> = new Map(),
): Record<string, PluginConfigValue> {
  const next = { ...parsed };
  for (const [key, value] of overrides) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

function readRequestedSecretClears(
  request: Readonly<Record<string, unknown>>,
  secretKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const clearSecrets = request.clearSecrets;
  if (clearSecrets !== undefined && (!Array.isArray(clearSecrets) || clearSecrets.some((key) => typeof key !== "string"))) {
    throw new Error("clearSecrets must be an array of Secret field keys");
  }
  const requestedClears = new Set((clearSecrets ?? []) as string[]);
  const unknownClears = [...requestedClears].filter((key) => !secretKeys.has(key));
  if (unknownClears.length > 0) {
    throw new Error(`Cannot clear non-Secret configuration field: ${unknownClears.join(", ")}`);
  }
  return requestedClears;
}

function secretValuesForRedaction(
  current: Readonly<Record<string, PluginConfigValue>>,
  input: unknown,
  secretFields: readonly PluginConfigField[],
): readonly string[] {
  const request = isRecord(input) ? input : {};
  const rawValues = isRecord(request.values) ? request.values : request;
  return [...new Set(secretFields.flatMap((field) => {
    const candidates = [current[field.key], rawValues[field.key]];
    return candidates.filter((value): value is string => typeof value === "string" && value.length > 0);
  }))];
}

function addSecretValuesForRedaction(
  candidates: Set<string>,
  values: Readonly<Record<string, PluginConfigValue>>,
  secretFields: readonly PluginConfigField[],
): void {
  for (const field of secretFields) {
    const value = values[field.key];
    if (typeof value === "string" && value.length > 0) candidates.add(value);
  }
}

function redactSecretData(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactSecretsInString(value, secrets);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecretData(item, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactSecretData(item, secrets)]),
  );
}

function redactSecretError(error: unknown, secrets: readonly string[]): Error {
  return new Error(redactSecretsInString(
    error instanceof Error ? error.message : String(error),
    secrets,
  ));
}

function redactSecretsInString(value: string, secrets: readonly string[]): string {
  return [...secrets]
    .sort((left, right) => right.length - left.length)
    .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
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

export type ToolLoggingPolicy = "full" | "metadata" | "redacted" | "none";

export interface ToolLoggingPolicies {
  /** Controls whether and how the JSON-RPC request body is logged. */
  readonly input?: ToolLoggingPolicy;
  /** Controls whether and how the JSON-RPC response body is logged. */
  readonly output?: ToolLoggingPolicy;
}

export interface PersonalMcpToolMetadata {
  readonly name: string;
  readonly title: string;
  readonly risk: ToolRisk;
  /** Interaction hint only. The MCP server must still enforce authorization and safety. */
  readonly requiresConfirmation?: boolean;
  /** Discovery/exposure hint only. The MCP server remains the authoritative safety boundary. */
  readonly disabledByDefault?: boolean;
  /** Enforced by the Runtime; Plugins must not log Tool payloads themselves. */
  readonly logging?: ToolLoggingPolicies;
}

export type PluginHealthState =
  | "unknown"
  | "unconfigured"
  | "healthy"
  | "degraded"
  | "unhealthy";

export interface PluginHealth {
  readonly state: PluginHealthState;
  readonly message?: string;
  readonly latencyMs?: number;
  readonly checkedAt?: string;
}

export interface PersonalMcpPlugin extends PersonalMcpPluginMetadata {
  readonly tools: readonly PersonalMcpToolMetadata[];
  readonly config?: {
    readonly fields: readonly PluginConfigField[];
  };
  /** Optional, side-effect-free backend check. Registration does not depend on its result. */
  checkHealth?(signal: AbortSignal): PluginHealth | Promise<PluginHealth>;
  createServer(): McpServer;
}

/** One runtime configuration/health instance of a Plugin. Only `default` is mounted today. */
export interface PersonalMcpProfile {
  readonly pluginId: string;
  readonly profileId: string;
  readonly plugin: PersonalMcpPlugin;
  readonly configManager?: McpConfigManager;
}

/**
 * Runtime-owned declaration for an additional named Profile.
 *
 * This deliberately lives beside, rather than inside, the Plugin Definition: a deployment may
 * create any number of connections without changing the Plugin's catalog metadata or Tool schema.
 */
export interface PersonalMcpProfileDefinition {
  readonly pluginId: string;
  readonly profileId: string;
  /** Declared configuration keys to isolate when no Config Manager supplies field metadata. */
  readonly configKeys?: readonly string[];
  readonly createPlugin: (environment: NodeJS.ProcessEnv) => PersonalMcpPlugin;
  readonly createConfigManager?: (store: RuntimeConfigStore) => McpConfigManager;
}

/** Declarative registration plus the factories needed to create a runtime plugin. */
export interface PersonalMcpPluginDefinition {
  readonly metadata: PersonalMcpPluginMetadata;
  /** Default loopback port used by this Plugin's standalone entry point. */
  readonly defaultPort: number;
  readonly createPlugin: (environment: NodeJS.ProcessEnv) => PersonalMcpPlugin;
  readonly createConfigManager?: (store: RuntimeConfigStore) => McpConfigManager;
}
