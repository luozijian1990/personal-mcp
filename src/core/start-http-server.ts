import type { Server } from "node:http";

import type { Express } from "express";

export interface StartedHttpServer {
  readonly server: Server;
  readonly url: URL;
}

export async function startHttpServer(
  app: Express,
  host: string,
  port: number,
): Promise<StartedHttpServer> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("HTTP server did not expose a TCP address"));
        return;
      }
      resolve({ server, url: new URL(`http://${host}:${address.port}`) });
    });
  });
}

export function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid TCP port: ${value}`);
  }
  return port;
}
