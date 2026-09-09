import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import express from "express";
import type { Express, Request, Response } from "express";

import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { limitLogValue } from "./log-value.js";
import { McpRegistry } from "./mcp-registry.js";
import { resolvePluginHealth } from "./plugin-health.js";
import type {
  McpConfigManager,
  PersonalMcpPlugin,
  PersonalMcpProfile,
  ToolLoggingPolicy,
} from "./plugin.js";
import { DEFAULT_PROFILE_ID, RuntimeProfileRegistry } from "./plugin-profile.js";

const DEFAULT_TOOL_LOGGING_POLICY: ToolLoggingPolicy = "metadata";
const MAX_LOG_PAYLOAD_CHARACTERS = 100_000;

export interface HttpAppOptions {
  readonly host: string;
  readonly serviceName: string;
  readonly uiDirectory?: string;
  readonly logger?: Logger;
  readonly registry?: McpRegistry;
  readonly configManagers?: readonly McpConfigManager[];
  /** Runtime Profiles. Omit for the legacy one-default-Profile-per-Plugin behavior. */
  readonly profiles?: readonly PersonalMcpProfile[];
  readonly mounts?: readonly {
    readonly path: string;
    readonly plugin: PersonalMcpPlugin;
  }[];
}

export function createHttpApp(options: HttpAppOptions): Express {
  if (!isLoopbackHost(options.host)) {
    throw new Error(
      `Refusing to run unauthenticated MCP service on non-loopback host: ${options.host}`,
    );
  }
  const registry = options.registry ?? new McpRegistry(options.mounts ?? []);
  const runtimeProfiles = new RuntimeProfileRegistry(
    registry,
    options.profiles,
    options.configManagers,
  );
  const configManagers = runtimeProfiles.configManagers();

  const app = createMcpExpressApp({ host: options.host });
  const logger = options.logger ?? createLogger({ serviceName: options.serviceName });
  const redactLogValue = (value: unknown): unknown => {
    let redacted = value;
    for (const manager of configManagers) {
      try {
        redacted = manager.redactSecrets?.(redacted) ?? redacted;
      } catch {
        return "[REDACTED]";
      }
    }
    return redacted;
  };
  const safeLog = (
    level: "info" | "error",
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => {
    try {
      if (fields === undefined) {
        logger[level](event);
        return;
      }
      const protectedFields = redactLogValue(fields);
      logger[level](
        event,
        isRecord(protectedFields) ? protectedFields : { fields: "[REDACTED]" },
      );
    } catch {
      // Logging is observational and must never affect an MCP or configuration request.
    }
  };

  app.get("/api/status", async (_request, response) => {
    const endpoints = await Promise.all(registry.list().map(async ({ path, plugin }) => {
      const profiles = runtimeProfiles.list(plugin.id);
      const profileStatuses = await Promise.all(profiles.map(async (profile) => {
        const currentPlugin = profile.profileId === DEFAULT_PROFILE_ID
          ? registry.get(profile.pluginId)?.plugin ?? profile.plugin
          : profile.plugin;
        return {
          id: profile.profileId,
          configurable: profile.configManager !== undefined,
          health: redactHealthMessage(await resolvePluginHealth(currentPlugin, {
            onFailure: (error) => safeLog("error", "plugin.health_check_failed", {
              plugin: plugin.id,
              profile: profile.profileId,
              error: error instanceof Error ? error.message : String(error),
            }),
          }), redactLogValue),
        };
      }));
      const defaultProfile = profileStatuses.find(({ id }) => id === DEFAULT_PROFILE_ID);
      return {
        id: plugin.id,
        name: plugin.displayName,
        summary: plugin.summary,
        category: plugin.category,
        path,
        tools: plugin.tools,
        configurable: defaultProfile?.configurable ?? false,
        health: defaultProfile?.health ?? { state: "unknown" as const },
        profiles: profileStatuses,
      };
    }));
    response.json({
      service: options.serviceName,
      status: "online",
      auth: "none",
      bind: options.host,
      transport: "Streamable HTTP",
      endpoints,
      configs: configManagers.map((manager) => manager.getSnapshot()),
    });
  });

  app.get("/api/config", (_request, response) => {
    response.json({ configs: configManagers.map((manager) => manager.getSnapshot()) });
  });

  const reloadConfig = async (
    pluginId: string,
    profileId: string,
    response: Response,
    operation: "update" | "reload",
    input?: unknown,
  ) => {
    const manager = runtimeProfiles.getConfigManager(pluginId, profileId);
    if (manager === undefined) {
      const target = profileId === DEFAULT_PROFILE_ID ? pluginId : `${pluginId}/${profileId}`;
      response.status(404).json({ error: `MCP configuration not found: ${target}` });
      return;
    }
    try {
      const update = operation === "update"
        ? await manager.update(input)
        : await manager.reload();
      safeLog("info", "config.updated", {
        plugin: pluginId,
        profile: profileId,
        changed_keys: update.changedKeys,
        operation,
        revision: update.snapshot.revision,
      });
      response.json({ config: update.snapshot, reloaded: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      safeLog("error", "config.update_failed", { plugin: pluginId, profile: profileId, operation, error: message });
      response.status(400).json({ error: message, reloaded: false });
    }
  };

  app.get("/api/config/:pluginId", (request, response) => {
    const manager = runtimeProfiles.getConfigManager(request.params.pluginId);
    if (manager === undefined) {
      response.status(404).json({ error: `MCP configuration not found: ${request.params.pluginId}` });
      return;
    }
    response.json({ config: manager.getSnapshot() });
  });

  app.put("/api/config/:pluginId", (request, response) => {
    void reloadConfig(request.params.pluginId, DEFAULT_PROFILE_ID, response, "update", request.body);
  });

  app.post("/api/config/:pluginId/reload", (request, response) => {
    void reloadConfig(request.params.pluginId, DEFAULT_PROFILE_ID, response, "reload");
  });

  app.get("/api/config/:pluginId/profiles/:profileId", (request, response) => {
    const manager = runtimeProfiles.getConfigManager(
      request.params.pluginId,
      request.params.profileId,
    );
    if (manager === undefined) {
      response.status(404).json({
        error: `MCP configuration not found: ${request.params.pluginId}/${request.params.profileId}`,
      });
      return;
    }
    response.json({ config: manager.getSnapshot() });
  });

  app.put("/api/config/:pluginId/profiles/:profileId", (request, response) => {
    void reloadConfig(request.params.pluginId, request.params.profileId, response, "update", request.body);
  });

  app.post("/api/config/:pluginId/profiles/:profileId/reload", (request, response) => {
    void reloadConfig(request.params.pluginId, request.params.profileId, response, "reload");
  });

  const healthHandler = (_request: Request, response: Response) => {
    response.json({ status: "ok" });
  };

  app.get("/health", healthHandler);
  app.get("/healthz", healthHandler);

  app.get("/favicon.ico", (_request, response) => {
    response.status(204).end();
  });

  for (const mount of registry.list()) {
    const pluginId = mount.plugin.id;
    const handler = toNodeHandler(
      createMcpHandler(() => {
        const current = registry.get(pluginId);
        if (current === undefined) throw new Error(`MCP plugin is no longer mounted: ${pluginId}`);
        return current.plugin.createServer();
      }),
      {
        onerror: (error) => {
          safeLog("error", "mcp.handler_error", {
            plugin: pluginId,
            endpoint: mount.path,
            error: redactLogValue(error.message),
          });
        },
      },
    );
    app.all(mount.path, (request, response) => {
      const requestId = randomUUID();
      const startedAt = performance.now();
      const currentPlugin = registry.get(pluginId)?.plugin;
      const requestMetadata = readMcpRequestMetadata(request.body);
      const tool = currentPlugin?.tools.find((candidate) => candidate.name === requestMetadata.tool);
      const inputPolicy = normalizeLoggingPolicy(tool?.logging?.input);
      const outputPolicy = normalizeLoggingPolicy(tool?.logging?.output);
      const outputChunks: string[] = [];
      let outputCharacters = 0;
      let outputTruncated = false;
      let responseLogged = false;

      const captureOutput = (chunk: unknown) => {
        try {
          if (chunk === undefined || chunk === null || typeof chunk === "function") return;
          const text = typeof chunk === "string"
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString("utf8")
              : chunk instanceof Uint8Array
                ? Buffer.from(chunk).toString("utf8")
                : String(chunk);
          if (outputCharacters >= MAX_LOG_PAYLOAD_CHARACTERS) {
            outputTruncated = true;
            return;
          }
          const remaining = MAX_LOG_PAYLOAD_CHARACTERS - outputCharacters;
          if (text.length > remaining) outputTruncated = true;
          outputChunks.push(text.slice(0, remaining));
          outputCharacters += Math.min(text.length, remaining);
        } catch {
          outputTruncated = true;
        }
      };

      // Capture both streamed chunks and a final body passed to response.end().
      const mutableResponse = response as unknown as {
        write: (...args: unknown[]) => unknown;
        end: (...args: unknown[]) => unknown;
      };
      const originalWrite = mutableResponse.write.bind(response);
      const originalEnd = mutableResponse.end.bind(response);
      mutableResponse.write = (...args) => {
        captureOutput(args[0]);
        return originalWrite(...args);
      };
      mutableResponse.end = (...args) => {
        captureOutput(args[0]);
        return originalEnd(...args);
      };

      const logResponse = (completed: boolean) => {
        if (responseLogged) return;
        responseLogged = true;
        if (outputPolicy === "none") return;
        try {
          const fields: Record<string, unknown> = {
            request_id: requestId,
            plugin: pluginId,
            tool: requestMetadata.tool,
            status: response.statusCode,
            duration_ms: Math.round(performance.now() - startedAt),
            completed,
            truncated: outputTruncated,
          };
          const output = outputTruncated && outputPolicy === "full"
            ? "[TRUNCATED]"
            : loggingPayload(
              outputPolicy,
              parseMcpOutput(outputChunks.join("")),
              redactLogValue,
            );
          if (output !== undefined) fields.output = output;
          safeLog("info", "mcp.response", fields);
        } catch {
          // Payload parsing, redaction, and formatting are part of the isolated logging boundary.
        }
      };

      response.once("finish", () => logResponse(true));
      response.once("close", () => logResponse(false));
      if (inputPolicy !== "none") {
        try {
          const fields: Record<string, unknown> = {
            request_id: requestId,
            plugin: pluginId,
            endpoint: mount.path,
            http_method: request.method,
            ...requestMetadata,
          };
          const input = loggingPayload(inputPolicy, request.body ?? null, redactLogValue);
          if (input !== undefined) fields.input = input;
          safeLog("info", "mcp.request", fields);
        } catch {
          // Logging failures must not prevent the handler from receiving the request.
        }
      }

      void handler(request, response, request.body).catch((error: unknown) => {
        safeLog("error", "mcp.handler_rejected", {
          request_id: requestId,
          plugin: pluginId,
          endpoint: mount.path,
          error: redactLogValue(error instanceof Error ? error.message : String(error)),
        });
      });
    });
  }

  if (options.uiDirectory !== undefined) {
    app.use("/assets", express.static(`${options.uiDirectory}/assets`));
    app.get("/", (_request, response) => {
      response.sendFile(`${options.uiDirectory}/index.html`);
    });
  }

  return app;
}

export function parseMcpOutput(output: string): unknown {
  const trimmed = output.trim();
  if (trimmed.length === 0) return null;

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => parsePayload(line.slice("data:".length).trimStart()));
  if (dataLines.length === 1) return dataLines[0];
  if (dataLines.length > 1) return dataLines;
  return parsePayload(trimmed);
}

function readMcpRequestMetadata(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const params = isRecord(input.params) ? input.params : undefined;
  return {
    rpc_id: input.id,
    rpc_method: input.method,
    tool: input.method === "tools/call" ? params?.name : undefined,
  };
}

function normalizeLoggingPolicy(policy: unknown): ToolLoggingPolicy {
  return policy === "full" || policy === "metadata" || policy === "redacted" || policy === "none"
    ? policy
    : DEFAULT_TOOL_LOGGING_POLICY;
}

function loggingPayload(
  policy: ToolLoggingPolicy,
  value: unknown,
  redactSecrets: (value: unknown) => unknown,
): unknown {
  if (policy === "metadata" || policy === "none") return undefined;
  if (policy === "redacted") return "[REDACTED]";
  return limitLogValue(redactSecrets(value), MAX_LOG_PAYLOAD_CHARACTERS);
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactHealthMessage(
  health: import("./plugin.js").PluginHealth,
  redact: (value: unknown) => unknown,
): import("./plugin.js").PluginHealth {
  if (health.message === undefined) return health;
  const message = redact(health.message);
  return { ...health, message: typeof message === "string" ? message : "[REDACTED]" };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
