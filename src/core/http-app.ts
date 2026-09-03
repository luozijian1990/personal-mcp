import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import express from "express";
import type { Express } from "express";

import type { PersonalMcpPlugin } from "./plugin.js";

export interface HttpAppOptions {
  readonly host: string;
  readonly serviceName: string;
  readonly uiDirectory?: string;
  readonly mounts: readonly {
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

  const app = createMcpExpressApp({ host: options.host });

  app.get("/api/status", (_request, response) => {
    response.json({
      service: options.serviceName,
      status: "online",
      auth: "none",
      bind: options.host,
      transport: "Streamable HTTP",
      endpoints: options.mounts.map(({ path, plugin }) => ({
        id: plugin.id,
        name: plugin.displayName,
        summary: plugin.summary,
        category: plugin.category,
        path,
        tools: plugin.tools,
      })),
    });
  });

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/favicon.ico", (_request, response) => {
    response.status(204).end();
  });

  for (const mount of options.mounts) {
    const handler = toNodeHandler(createMcpHandler(() => mount.plugin.createServer()));
    app.all(mount.path, (request, response) => {
      void handler(request, response, request.body);
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

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
