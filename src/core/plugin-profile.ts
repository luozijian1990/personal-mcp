import { McpRegistry } from "./mcp-registry.js";
import type {
  McpConfigManager,
  PersonalMcpPlugin,
  PersonalMcpProfile,
} from "./plugin.js";
import type { RuntimeConfigValues } from "./runtime-config.js";

/** Compatibility Profile used when a Plugin has not opted into named Profiles. */
export const DEFAULT_PROFILE_ID = "default";
const RUNTIME_PROFILE_CONFIG_PREFIX = "MCP_PROFILE__";

interface MutableRuntimeProfile {
  readonly pluginId: string;
  readonly profileId: string;
  plugin: PersonalMcpPlugin;
  readonly configManager?: McpConfigManager;
}

/** Owns Profile identity, configuration-manager lookup, and runtime instance replacement. */
export class RuntimeProfileRegistry {
  private readonly profiles = new Map<string, MutableRuntimeProfile>();
  private readonly managers = new Map<string, McpConfigManager>();

  constructor(
    private readonly registry: McpRegistry,
    suppliedProfiles?: readonly PersonalMcpProfile[],
    suppliedManagers: readonly McpConfigManager[] = [],
  ) {
    const managers = [
      ...suppliedManagers,
      ...(suppliedProfiles?.flatMap((profile) => profile.configManager === undefined
        ? []
        : [profile.configManager]) ?? []),
    ];
    for (const manager of managers) {
      const key = profileIdentityKey(manager.pluginId, manager.profileId ?? DEFAULT_PROFILE_ID);
      const existing = this.managers.get(key);
      if (existing !== undefined && existing !== manager) {
        throw new Error("Duplicate MCP configuration manager Profile");
      }
      this.managers.set(key, manager);
    }

    const source = suppliedProfiles ?? registry.list().map(({ plugin }) => {
      const configManager = this.managers.get(profileIdentityKey(plugin.id, DEFAULT_PROFILE_ID));
      return {
        pluginId: plugin.id,
        profileId: DEFAULT_PROFILE_ID,
        plugin,
        ...(configManager === undefined ? {} : { configManager }),
      };
    });
    for (const profile of source) this.register(profile);

    for (const { plugin } of registry.list()) {
      if (!this.profiles.has(profileIdentityKey(plugin.id, DEFAULT_PROFILE_ID))) {
        throw new Error(`Mounted MCP plugin has no default Profile: ${plugin.id}`);
      }
    }
    for (const [key, manager] of this.managers) {
      if (registry.get(manager.pluginId) === undefined) {
        throw new Error(`Configuration manager has no mounted MCP plugin: ${manager.pluginId}`);
      }
      const profile = this.profiles.get(key);
      if (profile === undefined) {
        throw new Error(
          `Configuration manager has no runtime Profile: ${manager.pluginId}/${manager.profileId ?? DEFAULT_PROFILE_ID}`,
        );
      }
      manager.setRuntimeReplacement?.((plugin) => this.replace(profile, plugin));
    }
  }

  list(pluginId?: string): readonly PersonalMcpProfile[] {
    return [...this.profiles.values()]
      .filter((profile) => pluginId === undefined || profile.pluginId === pluginId)
      .map((profile) => ({ ...profile }));
  }

  configManagers(): readonly McpConfigManager[] {
    return [...this.managers.values()];
  }

  getConfigManager(pluginId: string, profileId = DEFAULT_PROFILE_ID): McpConfigManager | undefined {
    return this.managers.get(profileIdentityKey(pluginId, profileId));
  }

  private register(profile: PersonalMcpProfile): void {
    validateProfileId(profile.profileId);
    if (profile.plugin.id !== profile.pluginId) {
      throw new Error(
        `Runtime Profile ${profile.pluginId}/${profile.profileId} contains Plugin ${profile.plugin.id}`,
      );
    }
    if (this.registry.get(profile.pluginId) === undefined) {
      throw new Error(`Runtime Profile references unmounted MCP plugin: ${profile.pluginId}`);
    }
    const key = profileIdentityKey(profile.pluginId, profile.profileId);
    if (this.profiles.has(key)) {
      throw new Error(`Duplicate runtime MCP Profile: ${profile.pluginId}/${profile.profileId}`);
    }
    const configManager = profile.configManager ?? this.managers.get(key);
    this.profiles.set(key, {
      ...profile,
      ...(configManager === undefined ? {} : { configManager }),
    });
  }

  private replace(profile: MutableRuntimeProfile, plugin: PersonalMcpPlugin): void {
    if (plugin.id !== profile.pluginId) {
      throw new Error(
        `Cannot replace Profile ${profile.pluginId}/${profile.profileId} with Plugin ${plugin.id}`,
      );
    }
    profile.plugin = plugin;
    if (profile.profileId === DEFAULT_PROFILE_ID) this.registry.replace(profile.pluginId, plugin);
  }
}

/** Collision-free in-memory identity for a Plugin/Profile pair. */
export function profileIdentityKey(pluginId: string, profileId: string): string {
  return `${pluginId.length}:${pluginId}${profileId.length}:${profileId}`;
}

/** Creates the persisted/environment key used to isolate a named Profile's ordinary field key. */
export function runtimeProfileConfigKey(pluginId: string, profileId: string, key: string): string {
  if (profileId === DEFAULT_PROFILE_ID) return key;
  return `${RUNTIME_PROFILE_CONFIG_PREFIX}${profileIdentityKey(pluginId, profileId)}:${key}`;
}

/**
 * Builds the environment seen by one Profile.
 * Named Profiles never inherit their declared configuration fields from the default Profile.
 */
export function runtimeProfileEnvironment(
  environment: NodeJS.ProcessEnv,
  pluginId: string,
  profileId: string,
  configKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  if (profileId === DEFAULT_PROFILE_ID) return { ...environment };
  const prefix = runtimeProfileConfigKey(pluginId, profileId, "");
  const isolated = { ...environment };
  for (const key of configKeys) delete isolated[key];
  const profileValues = Object.fromEntries(Object.entries(environment)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value]));
  return { ...isolated, ...profileValues };
}

export function runtimeProfileConfigValues(
  values: RuntimeConfigValues,
  pluginId: string,
  profileId: string,
): RuntimeConfigValues {
  if (profileId === DEFAULT_PROFILE_ID) return values;
  return Object.fromEntries(Object.entries(values)
    .map(([key, value]) => [runtimeProfileConfigKey(pluginId, profileId, key), value]));
}

export function validateProfileId(profileId: string): void {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(profileId)) {
    throw new Error(`Invalid MCP Profile id: ${profileId}`);
  }
}
