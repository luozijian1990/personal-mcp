import type { ElasticsearchPluginConfig } from "./config.js";
import { ELASTICSEARCH_MAX_INDEX_EXPRESSION_LENGTH } from "./constants.js";

export type JsonRecord = Record<string, unknown>;

export interface ElasticsearchSearchRequest {
  readonly index: string;
  readonly body: JsonRecord;
}

export interface ElasticsearchReadClient {
  getRoot(signal?: AbortSignal): Promise<JsonRecord>;
  getClusterHealth(signal?: AbortSignal): Promise<JsonRecord>;
  listIndices(pattern?: string, signal?: AbortSignal): Promise<readonly JsonRecord[]>;
  listShards(index?: string, signal?: AbortSignal): Promise<readonly JsonRecord[]>;
  explainAllocation(input: JsonRecord, signal?: AbortSignal): Promise<JsonRecord>;
  getMapping(index: string, signal?: AbortSignal): Promise<JsonRecord>;
  getFieldCaps(index: string, fields: readonly string[], signal?: AbortSignal): Promise<JsonRecord>;
  search(input: ElasticsearchSearchRequest, signal?: AbortSignal): Promise<JsonRecord>;
}

export class ElasticsearchRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errorType?: string,
  ) {
    super(message);
    this.name = "ElasticsearchRequestError";
  }
}

export function createElasticsearchReadClient(config: ElasticsearchPluginConfig): ElasticsearchReadClient {
  const request = async (
    method: "GET" | "POST",
    path: string,
    options: {
      readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
      readonly body?: JsonRecord;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<unknown> => {
    const endpoint = buildEndpoint(config.url, path, options.query);
    const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
    const signal = options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const authorization = basicAuthorization(config);
    if (authorization !== undefined) headers.authorization = authorization;
    try {
      const response = await fetch(endpoint, {
        method,
        headers,
        signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const body = await readBoundedJson(response, backendResponseLimit(config.maxResponseBytes));
      if (!response.ok) throw httpError(response.status, body, config);
      return body;
    } catch (error) {
      if (error instanceof ElasticsearchRequestError) throw error;
      if (timeoutSignal.aborted && !options.signal?.aborted) {
        throw new ElasticsearchRequestError(`request timed out after ${config.requestTimeoutMs} ms`);
      }
      if (options.signal?.aborted) throw new ElasticsearchRequestError("request was cancelled");
      throw new ElasticsearchRequestError(`network request failed: ${safeMessage(error, config)}`);
    }
  };

  return {
    getRoot: async (signal) => requireRecord(await request("GET", "", { signal }), "root response"),
    getClusterHealth: async (signal) => requireRecord(await request("GET", "_cluster/health", { signal }), "cluster health response"),
    listIndices: async (pattern, signal) => requireRecordArray(await request(
      "GET",
      pattern === undefined ? "_cat/indices" : `_cat/indices/${encodeIndexExpression(pattern)}`,
      { query: { format: "json", bytes: "b", h: "health,status,index,pri,rep,docs.count,store.size" }, signal },
    ), "indices response"),
    listShards: async (index, signal) => requireRecordArray(await request(
      "GET",
      index === undefined ? "_cat/shards" : `_cat/shards/${encodeIndexExpression(index)}`,
      { query: { format: "json", bytes: "b", h: "index,shard,prirep,state,node,docs,store,unassigned.reason" }, signal },
    ), "shards response"),
    explainAllocation: async (input, signal) => requireRecord(await request(
      "POST",
      "_cluster/allocation/explain",
      { body: input, signal },
    ), "allocation response"),
    getMapping: async (index, signal) => requireRecord(await request(
      "GET",
      `${encodeIndexExpression(index)}/_mapping`,
      { signal },
    ), "mapping response"),
    getFieldCaps: async (index, fields, signal) => requireRecord(await request(
      "GET",
      `${encodeIndexExpression(index)}/_field_caps`,
      { query: { fields: fields.length === 0 ? "*" : fields.join(",") }, signal },
    ), "field capabilities response"),
    search: async (input, signal) => requireRecord(await request(
      "POST",
      `${encodeIndexExpression(input.index)}/_search`,
      { body: input.body, signal },
    ), "search response"),
  };
}

export function validateIndexExpression(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("index must not be empty");
  if (normalized.length > ELASTICSEARCH_MAX_INDEX_EXPRESSION_LENGTH) {
    throw new Error(`index must not exceed ${ELASTICSEARCH_MAX_INDEX_EXPRESSION_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized) || /[?#]/u.test(normalized) || hasUnsafePathDelimiter(normalized)) {
    throw new Error("index contains a forbidden control or URL path character");
  }
  return normalized;
}

function encodeIndexExpression(value: string): string {
  return encodeURIComponent(validateIndexExpression(value));
}

function buildEndpoint(
  base: string,
  requestPath: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): URL {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const endpoint = new URL(requestPath, normalizedBase);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) endpoint.searchParams.set(key, String(value));
  }
  return endpoint;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new ElasticsearchRequestError(`backend response exceeds the ${maximumBytes} byte safety limit`, response.status);
  }
  if (response.body === null) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new ElasticsearchRequestError(`backend response exceeds the ${maximumBytes} byte safety limit`, response.status);
    }
    chunks.push(result.value);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw new ElasticsearchRequestError(`Elasticsearch returned invalid JSON (HTTP ${response.status})`, response.status);
  }
}

function backendResponseLimit(outputLimit: number): number {
  return Math.min(8 * 1024 * 1024, Math.max(256 * 1024, outputLimit * 4));
}

function httpError(status: number, body: unknown, config: ElasticsearchPluginConfig): ElasticsearchRequestError {
  const error = isRecord(body) ? body.error : undefined;
  const errorType = typeof error === "string"
    ? undefined
    : isRecord(error) && typeof error.type === "string" ? error.type : undefined;
  const reason = typeof error === "string"
    ? error
    : isRecord(error) && typeof error.reason === "string" ? error.reason : undefined;
  const suffix = reason === undefined ? "" : `: ${truncate(redactSensitive(reason, config), 512)}`;
  return new ElasticsearchRequestError(`Elasticsearch returned HTTP ${status}${suffix}`, status, errorType);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new ElasticsearchRequestError(`Elasticsearch ${label} must be a JSON object`);
  return value;
}

function requireRecordArray(value: unknown, label: string): readonly JsonRecord[] {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    throw new ElasticsearchRequestError(`Elasticsearch ${label} must be a JSON array of objects`);
  }
  return value as JsonRecord[];
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown, config: ElasticsearchPluginConfig): string {
  return truncate(redactSensitive(error instanceof Error ? error.message : String(error), config), 512);
}

function redactSensitive(value: string, config: ElasticsearchPluginConfig): string {
  const authorization = basicAuthorization(config);
  const token = authorization?.slice("Basic ".length);
  const secrets = [
    authorization === undefined ? undefined : `Authorization: ${authorization}`,
    authorization === undefined ? undefined : `authorization: ${authorization}`,
    authorization,
    token,
    config.password,
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
    .sort((left, right) => right.length - left.length);
  return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), value);
}

function basicAuthorization(config: ElasticsearchPluginConfig): string | undefined {
  if (config.username.length === 0) return undefined;
  return `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`;
}

function hasUnsafePathDelimiter(value: string): boolean {
  let angleDepth = 0;
  let braceDepth = 0;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      if (angleDepth === 0) return true;
      escaped = true;
      continue;
    }
    if (character === "<") angleDepth += 1;
    if (character === ">") {
      angleDepth -= 1;
      if (angleDepth < 0) return true;
    }
    if (character === "{" && angleDepth > 0) braceDepth += 1;
    if (character === "}" && angleDepth > 0) {
      braceDepth -= 1;
      if (braceDepth < 0) return true;
    }
    if (character === "/" && (angleDepth === 0 || braceDepth === 0)) return true;
  }
  return escaped || angleDepth !== 0 || braceDepth !== 0;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}
