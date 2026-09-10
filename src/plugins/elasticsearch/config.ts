import type { PluginConfigField } from "../../core/plugin.js";
import {
  ELASTICSEARCH_DEFAULT_MAX_HITS,
  ELASTICSEARCH_DEFAULT_MAX_RESPONSE_BYTES,
  ELASTICSEARCH_DEFAULT_REQUEST_TIMEOUT_MS,
  ELASTICSEARCH_HARD_MAX_HITS,
  ELASTICSEARCH_MAX_REQUEST_TIMEOUT_MS,
  ELASTICSEARCH_MAX_RESPONSE_BYTES,
  ELASTICSEARCH_MIN_REQUEST_TIMEOUT_MS,
  ELASTICSEARCH_MIN_RESPONSE_BYTES,
} from "./constants.js";

export const ELASTICSEARCH_CONFIG_FIELDS: readonly PluginConfigField[] = [
  {
    key: "ELASTICSEARCH_MCP_URL",
    label: "Elasticsearch URL",
    description: "Elasticsearch 7 HTTP(S) 地址；可包含反向代理 base path，但不能包含凭据、query 或 fragment。",
    type: "text",
    defaultValue: "",
    required: true,
    placeholder: "https://elasticsearch.example.com:9200",
  },
  {
    key: "ELASTICSEARCH_MCP_USERNAME",
    label: "Username",
    description: "Basic Auth 用户名；匿名集群可留空。用户名和密码必须同时配置或同时留空。",
    type: "text",
    defaultValue: "",
  },
  {
    key: "ELASTICSEARCH_MCP_PASSWORD",
    label: "Password",
    description: "Basic Auth 密码。该字段使用 Framework Secret 生命周期，不会出现在公开配置快照中。",
    type: "password",
    defaultValue: "",
    secret: true,
  },
  {
    key: "ELASTICSEARCH_MCP_REQUEST_TIMEOUT",
    label: "Request timeout (ms)",
    description: `单次 Elasticsearch 请求超时，范围 ${ELASTICSEARCH_MIN_REQUEST_TIMEOUT_MS}-${ELASTICSEARCH_MAX_REQUEST_TIMEOUT_MS} 毫秒。`,
    type: "number",
    defaultValue: ELASTICSEARCH_DEFAULT_REQUEST_TIMEOUT_MS,
    required: true,
  },
  {
    key: "ELASTICSEARCH_MCP_MAX_HITS",
    label: "Maximum search hits",
    description: `单次 search 最大 hits；超过限制会拒绝而不是静默裁剪，最大可配置为 ${ELASTICSEARCH_HARD_MAX_HITS}。`,
    type: "number",
    defaultValue: ELASTICSEARCH_DEFAULT_MAX_HITS,
    required: true,
  },
  {
    key: "ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES",
    label: "Maximum response bytes",
    description: `单个序列化 MCP CallToolResult（text + structuredContent）的 UTF-8 字节上限，范围 ${ELASTICSEARCH_MIN_RESPONSE_BYTES}-${ELASTICSEARCH_MAX_RESPONSE_BYTES}；不含 JSON-RPC/HTTP envelope。`,
    type: "number",
    defaultValue: ELASTICSEARCH_DEFAULT_MAX_RESPONSE_BYTES,
    required: true,
  },
];

export interface ElasticsearchPluginConfig {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly requestTimeoutMs: number;
  readonly maxHits: number;
  readonly maxResponseBytes: number;
}

export function loadElasticsearchPluginConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ElasticsearchPluginConfig {
  return {
    url: (environment.ELASTICSEARCH_MCP_URL ?? "").trim(),
    username: (environment.ELASTICSEARCH_MCP_USERNAME ?? "").trim(),
    password: environment.ELASTICSEARCH_MCP_PASSWORD ?? "",
    requestTimeoutMs: readNumber(environment.ELASTICSEARCH_MCP_REQUEST_TIMEOUT, ELASTICSEARCH_DEFAULT_REQUEST_TIMEOUT_MS),
    maxHits: readNumber(environment.ELASTICSEARCH_MCP_MAX_HITS, ELASTICSEARCH_DEFAULT_MAX_HITS),
    maxResponseBytes: readNumber(environment.ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES, ELASTICSEARCH_DEFAULT_MAX_RESPONSE_BYTES),
  };
}

export function validateElasticsearchConfig(config: ElasticsearchPluginConfig): void {
  if (config.url.length === 0) throw new Error("ELASTICSEARCH_MCP_URL must be configured");
  validateElasticsearchUrl(config.url);
  if ((config.username.length === 0) !== (config.password.length === 0)) {
    throw new Error("ELASTICSEARCH_MCP_USERNAME and ELASTICSEARCH_MCP_PASSWORD must be configured together");
  }
  validateIntegerRange(
    "ELASTICSEARCH_MCP_REQUEST_TIMEOUT",
    config.requestTimeoutMs,
    ELASTICSEARCH_MIN_REQUEST_TIMEOUT_MS,
    ELASTICSEARCH_MAX_REQUEST_TIMEOUT_MS,
  );
  validateIntegerRange("ELASTICSEARCH_MCP_MAX_HITS", config.maxHits, 1, ELASTICSEARCH_HARD_MAX_HITS);
  validateIntegerRange(
    "ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES",
    config.maxResponseBytes,
    ELASTICSEARCH_MIN_RESPONSE_BYTES,
    ELASTICSEARCH_MAX_RESPONSE_BYTES,
  );
}

export function validateElasticsearchUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ELASTICSEARCH_MCP_URL must be a valid HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ELASTICSEARCH_MCP_URL must use http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("ELASTICSEARCH_MCP_URL must not contain embedded credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("ELASTICSEARCH_MCP_URL must not contain a query string or fragment");
  }
}

function readNumber(value: string | undefined, fallback: number): number {
  return value === undefined || value.trim() === "" ? fallback : Number(value);
}

function validateIntegerRange(key: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
}
