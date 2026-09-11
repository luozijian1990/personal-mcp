import type { SkyWalkingPluginConfig } from "./config.js";
import { graphqlUrl } from "./config.js";

export async function skywalkingGraphql<T>(
  config: SkyWalkingPluginConfig,
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.username || config.password) {
    headers.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  }
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(graphqlUrl(config.url), {
    method: "POST", headers, body: JSON.stringify({ query, variables }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`SkyWalking OAP HTTP ${response.status}`);
  const body = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map(error => error.message).join("; "));
  if (!body.data) throw new Error("SkyWalking OAP returned no data");
  return body.data;
}
