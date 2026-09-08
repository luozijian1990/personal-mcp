import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import express from "express";
import type { Express, Request, Response } from "express";

import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { McpRegistry } from "./mcp-registry.js";
import type { McpConfigManager, PersonalMcpPlugin } from "./plugin.js";

export interface HttpAppOptions {
  readonly host: string;
  readonly serviceName: string;
  readonly uiDirectory?: string;
  readonly logger?: Logger;
  readonly registry?: McpRegistry;
  readonly configManagers?: readonly McpConfigManager[];
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
  const configManagers = new Map(
    (options.configManagers ?? []).map((manager) => [manager.pluginId, manager]),
  );
  for (const manager of configManagers.values()) {
    if (registry.get(manager.pluginId) === undefined) {
      throw new Error(`Configuration manager has no mounted MCP plugin: ${manager.pluginId}`);
    }
    manager.setRuntimeReplacement?.((plugin) => registry.replace(manager.pluginId, plugin));
  }
  if (configManagers.size !== (options.configManagers ?? []).length) {
    throw new Error("Duplicate MCP configuration manager");
  }

  const app = createMcpExpressApp({ host: options.host });
  const logger = options.logger ?? createLogger({ serviceName: options.serviceName });

  app.get("/api/status", (_request, response) => {
    response.json({
      service: options.serviceName,
      status: "online",
      auth: "none",
      bind: options.host,
      transport: "Streamable HTTP",
      endpoints: registry.list().map(({ path, plugin }) => ({
        id: plugin.id,
        name: plugin.displayName,
        summary: plugin.summary,
        category: plugin.category,
        path,
        tools: plugin.tools,
        configurable: configManagers.has(plugin.id),
      })),
      configs: [...configManagers.values()].map((manager) => manager.getSnapshot()),
    });
  });

  app.get("/api/config", (_request, response) => {
    response.json({ configs: [...configManagers.values()].map((manager) => manager.getSnapshot()) });
  });

  const reloadConfig = async (
    pluginId: string,
    response: Response,
    operation: "update" | "reload",
    input?: unknown,
  ) => {
    const manager = configManagers.get(pluginId);
    if (manager === undefined) {
      response.status(404).json({ error: `MCP configuration not found: ${pluginId}` });
      return;
    }
    try {
      const update = operation === "update"
        ? await manager.update(input)
        : await manager.reload();
      logger.info("config.updated", {
        plugin: pluginId,
        changed_keys: update.changedKeys,
        operation,
        revision: update.snapshot.revision,
      });
      response.json({ config: update.snapshot, reloaded: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("config.update_failed", { plugin: pluginId, operation, error: message });
      response.status(400).json({ error: message, reloaded: false });
    }
  };

  app.get("/api/config/:pluginId", (request, response) => {
    const manager = configManagers.get(request.params.pluginId);
    if (manager === undefined) {
      response.status(404).json({ error: `MCP configuration not found: ${request.params.pluginId}` });
      return;
    }
    response.json({ config: manager.getSnapshot() });
  });

  app.put("/api/config/:pluginId", (request, response) => {
    void reloadConfig(request.params.pluginId, response, "update", request.body);
  });

  app.post("/api/config/:pluginId/reload", (request, response) => {
    void reloadConfig(request.params.pluginId, response, "reload");
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
          logger.error("mcp.handler_error", {
            plugin: pluginId,
            endpoint: mount.path,
            error: error.message,
          });
        },
      },
    );
    app.all(mount.path, (request, response) => {
      const requestId = randomUUID();
      const startedAt = performance.now();
      const outputChunks: string[] = [];
      const maxOutputCharacters = 100_000;
      let outputCharacters = 0;
      let outputTruncated = false;
      let responseLogged = false;

      const captureOutput = (chunk: unknown) => {
        if (chunk === undefined || chunk === null || typeof chunk === "function") return;
        const text = typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : chunk instanceof Uint8Array
              ? Buffer.from(chunk).toString("utf8")
              : String(chunk);
        if (outputCharacters >= maxOutputCharacters) {
          outputTruncated = true;
          return;
        }
        const remaining = maxOutputCharacters - outputCharacters;
        if (text.length > remaining) outputTruncated = true;
        outputChunks.push(text.slice(0, remaining));
        outputCharacters += Math.min(text.length, remaining);
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
        logger.info("mcp.response", {
          request_id: requestId,
          plugin: pluginId,
          status: response.statusCode,
          duration_ms: Math.round(performance.now() - startedAt),
          completed,
          truncated: outputTruncated,
          output: parseMcpOutput(outputChunks.join("")),
        });
      };

      response.once("finish", () => logResponse(true));
      response.once("close", () => logResponse(false));
      const requestMetadata = readMcpRequestMetadata(request.body);
      logger.info("mcp.request", {
        request_id: requestId,
        plugin: pluginId,
        endpoint: mount.path,
        http_method: request.method,
        ...requestMetadata,
        input: request.body ?? null,
      });

      void handler(request, response, request.body).catch((error: unknown) => {
        logger.error("mcp.handler_rejected", {
          request_id: requestId,
          plugin: pluginId,
          endpoint: mount.path,
          error: error instanceof Error ? error.message : String(error),
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

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
