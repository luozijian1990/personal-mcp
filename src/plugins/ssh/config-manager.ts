import { readFile } from "node:fs/promises";

import { createSshPlugin } from "./index.js";
import {
  SSH_CONFIG_FIELDS,
  type SshPluginConfig,
  loadSshPluginConfig,
} from "./config.js";
import { knownHostKeysFor, targetHost } from "./ssh-runner.js";
import type { McpConfigManager, PluginConfigValue } from "../../core/plugin.js";
import { createGenericConfigManager } from "../../core/plugin-config-manager.js";
import type { RuntimeConfigStore } from "../../core/runtime-config.js";

const CONFIG_KEYS = new Set(SSH_CONFIG_FIELDS.map((field) => field.key));

export function createSshConfigManager(store: RuntimeConfigStore): McpConfigManager {
  return createGenericConfigManager({ pluginId: "ssh", fields: SSH_CONFIG_FIELDS, store,
    load: loadSshPluginConfig,
    values: (config) => ({ SSH_MCP_ALLOWED_TARGETS: [...config.allowedTargets].join(","), SSH_MCP_USERNAME: config.username ?? "", SSH_MCP_PORTS: config.ports.join(","), SSH_MCP_ALLOW_COMMANDS: config.allowCommands, SSH_MCP_PRIVATE_KEY_PATH: config.privateKeyPath ?? "", SSH_MCP_KNOWN_HOSTS_PATH: config.knownHostsPath ?? "" }),
    parse: (input, current) => validateValues({ ...current, ...parseInput(input) }),
    environment: (values, base) => ({ ...base, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) }),
    persist: (values) => ({ SSH_MCP_ALLOWED_TARGETS: String(values.SSH_MCP_ALLOWED_TARGETS), SSH_MCP_USERNAME: String(values.SSH_MCP_USERNAME), SSH_MCP_PORTS: String(values.SSH_MCP_PORTS), SSH_MCP_ALLOW_COMMANDS: String(values.SSH_MCP_ALLOW_COMMANDS), SSH_MCP_PRIVATE_KEY_PATH: String(values.SSH_MCP_PRIVATE_KEY_PATH), SSH_MCP_KNOWN_HOSTS_PATH: String(values.SSH_MCP_KNOWN_HOSTS_PATH) }),
    validate: validateCredentialFiles,
    createPlugin: (config) => createSshPlugin({ config }),
  });
}

async function validateCredentialFiles(config: SshPluginConfig): Promise<void> {
  const privateKeyPath = config.privateKeyPath;
  const knownHostsPath = config.knownHostsPath;
  if (privateKeyPath === undefined || knownHostsPath === undefined) {
    throw new Error("SSH credential paths are required");
  }
  if (config.username === undefined || config.ports.length === 0) {
    throw new Error("SSH username and at least one port are required");
  }

  let privateKey: Buffer;
  let knownHosts: string;
  try {
    [privateKey, knownHosts] = await Promise.all([
      readFile(privateKeyPath),
      readFile(knownHostsPath, "utf8"),
    ]);
  } catch (error) {
    throw new Error(`Unable to read SSH credential files: ${errorMessage(error)}`);
  }
  if (knownHosts.trim().length === 0) {
    throw new Error("SSH known_hosts file must not be empty");
  }

  const ssh2 = await import("ssh2");
  const parseKey = ssh2.utils?.parseKey ?? ssh2.default.utils.parseKey;
  const parsedKey = parseKey(privateKey);
  if (parsedKey instanceof Error) {
    throw new Error(`Unable to parse SSH private key: ${parsedKey.message}`);
  }
  const parsedKeys = Array.isArray(parsedKey) ? parsedKey : [parsedKey];
  if (!parsedKeys.some((key) => key.isPrivateKey())) {
    throw new Error("SSH_MCP_PRIVATE_KEY_PATH must point to a private key");
  }

  for (const target of config.allowedTargets) {
    const host = targetHost(target);
    if (!config.ports.some((port) => knownHostKeysFor(knownHosts, host, port).size > 0)) {
      throw new Error(
        `SSH known_hosts has no entry for ${host} on configured ports: ${config.ports.join(",")}`,
      );
    }
  }
}

function parseInput(input: unknown): Record<string, PluginConfigValue> {
  const values = isRecord(input) && isRecord(input.values) ? input.values : input;
  if (!isRecord(values)) throw new Error("Configuration body must be an object");
  const unknownKeys = Object.keys(values).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown SSH configuration field: ${unknownKeys.join(", ")}`);
  }
  return values as Record<string, PluginConfigValue>;
}

function validateValues(values: Record<string, PluginConfigValue>): {
  SSH_MCP_ALLOWED_TARGETS: string;
  SSH_MCP_USERNAME: string;
  SSH_MCP_PORTS: string;
  SSH_MCP_ALLOW_COMMANDS: boolean;
  SSH_MCP_PRIVATE_KEY_PATH: string;
  SSH_MCP_KNOWN_HOSTS_PATH: string;
} {
  const targets = requireString(values, "SSH_MCP_ALLOWED_TARGETS");
  const targetList = targets.split(",").map((target) => target.trim()).filter(Boolean);
  if (targetList.length === 0) {
    throw new Error("SSH_MCP_ALLOWED_TARGETS must contain at least one host");
  }
  for (const target of targetList) {
    if (target.length > 255 || /[\s/@\\]/.test(target)) {
      throw new Error(`Invalid SSH target: ${target}`);
    }
  }

  const allowCommands = values.SSH_MCP_ALLOW_COMMANDS;
  if (typeof allowCommands !== "boolean") {
    throw new Error("SSH_MCP_ALLOW_COMMANDS must be a boolean");
  }

  const username = requireString(values, "SSH_MCP_USERNAME");
  if (username.length > 255 || /[\s@\0]/.test(username)) {
    throw new Error("SSH_MCP_USERNAME must be a valid SSH username without whitespace or @");
  }

  const portValues = requireString(values, "SSH_MCP_PORTS")
    .split(",")
    .map((value) => value.trim());
  if (portValues.length > 20) {
    throw new Error("SSH_MCP_PORTS supports at most 20 ports");
  }
  const ports: number[] = [];
  for (const value of portValues) {
    const port = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid SSH port: ${value}`);
    }
    if (!ports.includes(port)) ports.push(port);
  }

  return {
    SSH_MCP_ALLOWED_TARGETS: targetList.join(","),
    SSH_MCP_USERNAME: username,
    SSH_MCP_PORTS: ports.join(","),
    SSH_MCP_ALLOW_COMMANDS: allowCommands,
    SSH_MCP_PRIVATE_KEY_PATH: requireString(values, "SSH_MCP_PRIVATE_KEY_PATH"),
    SSH_MCP_KNOWN_HOSTS_PATH: requireString(values, "SSH_MCP_KNOWN_HOSTS_PATH"),
  };
}

function requireString(values: Record<string, PluginConfigValue>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
