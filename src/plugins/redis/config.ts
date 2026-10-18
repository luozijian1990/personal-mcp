import type { PluginConfigField } from "../../core/plugin.js";

const text = (key: string, label: string, defaultValue = ""): PluginConfigField => ({ key, label, description: label, type: "text", defaultValue });
const number = (key: string, label: string, defaultValue: number): PluginConfigField => ({ key, label, description: label, type: "number", defaultValue });
export const REDIS_CONFIG_FIELDS: readonly PluginConfigField[] = [
  text("REDIS_HOST", "Redis host", "localhost"), number("REDIS_PORT", "Redis port", 6379),
  text("REDIS_USERNAME", "ACL username (optional)"),
  { key: "REDIS_PASSWORD", label: "Password", description: "Optional Redis password", type: "password", secret: true, defaultValue: "" },
  number("REDIS_DB", "Default DB", 0),
  { key: "REDIS_TLS", label: "TLS", description: "Verify TLS certificate and hostname", type: "boolean", defaultValue: false },
  { key: "REDIS_CA", label: "Custom CA (PEM)", description: "Optional CA certificate PEM; requires TLS", type: "textarea", defaultValue: "" },
  { key: "REDIS_SLOWLOG_ARGUMENTS", label: "Expose slowlog arguments", description: "May expose business data; bounded previews only", type: "boolean", defaultValue: false, dangerous: true },
  number("REDIS_CONNECT_TIMEOUT_MS", "Connection timeout (ms)", 5000),
  number("REDIS_TIMEOUT_MS", "Total tool timeout (ms)", 5000),
  number("REDIS_SCAN_ROUNDS", "Maximum scan rounds", 10),
  number("REDIS_MAX_ITEMS", "Maximum items per call", 100),
  number("REDIS_MAX_VALUE_BYTES", "String preview bytes", 16384),
  number("REDIS_MAX_RESPONSE_BYTES", "Maximum MCP response bytes", 262144),
];
export interface RedisConfig {
  host: string; port: number; username: string; password: string; db: number; tls: boolean; ca: string;
  slowlogArguments: boolean; connectTimeoutMs: number; timeoutMs: number; scanRounds: number;
  maxItems: number; maxValueBytes: number; maxResponseBytes: number;
}
export function loadRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  const n = (key: string, fallback: number) => Number(env[key] ?? fallback);
  const b = (key: string) => { const v = env[key] ?? "false"; if (!['true', 'false'].includes(v)) throw new Error(`${key} must be true or false`); return v === 'true'; };
  return { host: env.REDIS_HOST?.trim() || "localhost", port: n("REDIS_PORT", 6379), username: env.REDIS_USERNAME ?? "", password: env.REDIS_PASSWORD ?? "", db: n("REDIS_DB", 0), tls: b("REDIS_TLS"), ca: env.REDIS_CA ?? "", slowlogArguments: b("REDIS_SLOWLOG_ARGUMENTS"), connectTimeoutMs: n("REDIS_CONNECT_TIMEOUT_MS", 5000), timeoutMs: n("REDIS_TIMEOUT_MS", 5000), scanRounds: n("REDIS_SCAN_ROUNDS", 10), maxItems: n("REDIS_MAX_ITEMS", 100), maxValueBytes: n("REDIS_MAX_VALUE_BYTES", 16384), maxResponseBytes: n("REDIS_MAX_RESPONSE_BYTES", 262144) };
}
export function validateRedisConfig(c: RedisConfig): void {
  for (const [key, value, min, max] of [
    ["port", c.port, 1, 65535], ["db", c.db, 0, 2147483647],
    ["connectTimeoutMs", c.connectTimeoutMs, 1, 60000], ["timeoutMs", c.timeoutMs, 1, 60000],
    ["scanRounds", c.scanRounds, 1, 100], ["maxItems", c.maxItems, 1, 1000],
    ["maxValueBytes", c.maxValueBytes, 1, 1048576], ["maxResponseBytes", c.maxResponseBytes, 4096, 4194304],
  ] as const) if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Redis ${key} must be an integer in ${min}..${max}`);
  if (c.username && !c.password) throw new Error("Redis username requires a password");
  if (c.ca && !c.tls) throw new Error("Redis CA requires TLS");
  if (c.ca && !c.ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("Redis CA must be PEM certificate text");
}
export function redisConfigValues(c: RedisConfig): Record<string, string | number | boolean> {
  return { REDIS_HOST: c.host, REDIS_PORT: c.port, REDIS_USERNAME: c.username, REDIS_PASSWORD: c.password, REDIS_DB: c.db, REDIS_TLS: c.tls, REDIS_CA: c.ca, REDIS_SLOWLOG_ARGUMENTS: c.slowlogArguments, REDIS_CONNECT_TIMEOUT_MS: c.connectTimeoutMs, REDIS_TIMEOUT_MS: c.timeoutMs, REDIS_SCAN_ROUNDS: c.scanRounds, REDIS_MAX_ITEMS: c.maxItems, REDIS_MAX_VALUE_BYTES: c.maxValueBytes, REDIS_MAX_RESPONSE_BYTES: c.maxResponseBytes };
}
