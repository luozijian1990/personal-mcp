import { z } from "zod/v4";
import { jaegerBaseUrl, type JaegerPluginConfig } from "./config.js";

const envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).nullish() });
/** HTTP JSON adapter for Jaeger Query 1.76. Never follow auth-bearing redirects. */
export async function jaegerGet<T>(config: JaegerPluginConfig, path: string, schema: z.ZodType<T>, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  if (!config.url) throw new Error("JAEGER_MCP_URL must be configured");
  const url = new URL(`${jaegerBaseUrl(config.url)}/api/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.username || config.password) headers.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(url, { headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`Jaeger Query HTTP ${response.status}`);
  // Read a bounded body: pagination cannot protect memory from a huge backend Trace.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Jaeger Query returned no response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) throw new Error("Jaeger response exceeds 16 MiB; narrow the search or use Jaeger UI for this Trace");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  let json: unknown;
  try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Jaeger Query returned invalid JSON"); }
  const body = envelope.safeParse(json);
  if (!body.success || !Object.hasOwn(body.data, "data")) throw new Error("Unexpected Jaeger Query response envelope");
  if (body.data.errors?.length) throw new Error("Jaeger Query reported backend errors; inspect backend logs");
  const result = schema.safeParse(body.data.data);
  if (!result.success) throw new Error("Unexpected Jaeger Query data shape (HTTP JSON API compatibility)");
  return result.data;
}
