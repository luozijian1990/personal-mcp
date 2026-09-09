import type { Server } from "node:http";

import type { Logger } from "./logger.js";
import { createHttpApp } from "./http-app.js";
import { McpRegistry } from "./mcp-registry.js";
import { initializePluginCatalog, type PluginCatalog } from "./plugin-catalog.js";
import type {
  PersonalMcpPluginDefinition,
  PersonalMcpProfileDefinition,
} from "./plugin.js";
import { createRuntimeConfigStore, type RuntimeConfigStore } from "./runtime-config.js";
import { readPort, startHttpServer } from "./start-http-server.js";

export interface StartedPluginRuntime {
  readonly server: Server;
  readonly url: URL;
  readonly catalog: PluginCatalog;
  readonly registry: McpRegistry;
}

export interface StartPluginRuntimeOptions {
  readonly serviceName: string;
  readonly definitions: readonly PersonalMcpPluginDefinition[];
  readonly profileDefinitions?: readonly PersonalMcpProfileDefinition[];
  readonly port: number;
  readonly host?: string;
  readonly uiDirectory?: string;
  readonly store?: RuntimeConfigStore;
  readonly logger?: Logger;
}

/** Shared bootstrap for both the multi-Plugin Gateway and standalone entry points. */
export async function startPluginRuntime(
  options: StartPluginRuntimeOptions,
): Promise<StartedPluginRuntime> {
  const host = options.host ?? "127.0.0.1";
  const catalog = initializePluginCatalog(
    options.store ?? createRuntimeConfigStore(),
    options.definitions,
    options.profileDefinitions,
  );
  const registry = new McpRegistry(catalog.mounts, options.store);
  const app = createHttpApp({
    host,
    serviceName: options.serviceName,
    registry,
    runtimeConfigStore: options.store ?? createRuntimeConfigStore(),
    profiles: catalog.profiles,
    ...(options.uiDirectory === undefined ? {} : { uiDirectory: options.uiDirectory }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const started = await startHttpServer(app, host, options.port);
  return { ...started, catalog, registry };
}

export interface StartStandalonePluginOptions {
  readonly host?: string;
  readonly port?: number;
  readonly store?: RuntimeConfigStore;
  readonly logger?: Logger;
}

/** Start one catalog Definition with the same Runtime lifecycle used by the Gateway. */
export async function startStandalonePlugin(
  definition: PersonalMcpPluginDefinition,
  options: StartStandalonePluginOptions = {},
): Promise<StartedPluginRuntime> {
  return await startPluginRuntime({
    serviceName: `${definition.metadata.id}-mcp-standalone`,
    definitions: [definition],
    port: options.port ?? resolveStandalonePort(definition),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

export function resolveStandalonePort(
  definition: PersonalMcpPluginDefinition,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return readPort(environment.PORT, definition.defaultPort);
}

export function reportStartedPluginRuntime(
  label: string,
  runtime: Pick<StartedPluginRuntime, "url" | "catalog">,
): void {
  console.error(`${label} listening on ${runtime.url.href}`);
  for (const { path, plugin } of runtime.catalog.mounts) {
    console.error(`${plugin.displayName} MCP endpoint: ${new URL(path, runtime.url).href}`);
  }
}
