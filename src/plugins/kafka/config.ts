import { auditBaselineSchema, parseAuditBaseline, type AuditBaseline } from "./audit.js";
import { createSecureContext } from "node:tls";
import type { PluginConfigField } from "../../core/plugin.js";

const text = (key: string, label: string, defaultValue = ""): PluginConfigField => ({ key, label, description: label, type: "text", defaultValue });
const number = (key: string, label: string, defaultValue: number): PluginConfigField => ({ key, label, description: label, type: "number", defaultValue });
export const KAFKA_CONFIG_FIELDS: readonly PluginConfigField[] = [
  text("KAFKA_BROKERS", "Bootstrap brokers (comma-separated host:port)"),
  { key: "KAFKA_BROKER_ADDRESS_MAP", label: "Broker address map (JSON)", description: "Exact advertised host:port to proxy host:port mapping; applies to Broker and Coordinator connections", type: "textarea", defaultValue: "{}" },
  text("KAFKA_CLIENT_ID", "Client ID", "personal-mcp-kafka"),
  { key: "KAFKA_TLS", label: "TLS", description: "Verify server certificate and hostname", type: "boolean", defaultValue: false },
  { key: "KAFKA_CA", label: "Custom CA PEM", description: "Optional PEM CA certificate; requires TLS", type: "textarea", defaultValue: "" },
  text("KAFKA_SASL_MECHANISM", "SASL: none / plain / scram-sha-256 / scram-sha-512", "none"),
  text("KAFKA_USERNAME", "SASL username"),
  { key: "KAFKA_PASSWORD", label: "SASL password", description: "Blank preserves existing secret; clearSecrets explicitly clears", type: "password", secret: true, defaultValue: "" },
  { key: "KAFKA_AUDIT_BASELINE", label: "Audit baseline (JSON)", description: "Optional business topic thresholds; empty means evidence-based rules only", type: "textarea", defaultValue: "{}" },
  number("KAFKA_STORAGE_IMBALANCE_RATIO", "Storage maximum/mean ratio threshold (0 disables)", 0),
  number("KAFKA_TIMEOUT_MS", "Total call budget (ms, maximum 30000)", 10000),
  number("KAFKA_MAX_ITEMS", "Maximum list items (up to 1000)", 1000),
  number("KAFKA_MAX_PARTITIONS", "Maximum partitions per lag query", 1000),
  number("KAFKA_CONCURRENCY", "Maximum concurrent backend requests", 5),
  number("KAFKA_MAX_RESPONSE_BYTES", "Maximum MCP response bytes", 2097152),
  number("KAFKA_MAX_BROKER_RESPONSE_BYTES", "Maximum individual Kafka response bytes", 16777216),
];
export interface KafkaConfig {
  auditBaseline: AuditBaseline; storageImbalanceRatio: number;
  addressMap: Record<string, string>; brokers: string[]; clientId: string; tls: boolean; ca: string;
  mechanism: "none" | "plain" | "scram-sha-256" | "scram-sha-512";
  username: string; password: string; timeoutMs: number; maxItems: number;
  maxPartitions: number; concurrency: number; maxResponseBytes: number; maxBrokerResponseBytes: number;
}
export function loadKafkaConfig(env: NodeJS.ProcessEnv = process.env): KafkaConfig {
  const n = (key: string, fallback: number) => Number(env[key] ?? fallback);
  if (env.KAFKA_TLS !== undefined && !["true", "false"].includes(env.KAFKA_TLS)) throw new Error("KAFKA_TLS must be true or false");
  const mechanism = env.KAFKA_SASL_MECHANISM ?? "none";
  if (!["none", "plain", "scram-sha-256", "scram-sha-512"].includes(mechanism)) throw new Error("Unsupported KAFKA_SASL_MECHANISM");
  return {
    auditBaseline: parseAuditBaseline(env.KAFKA_AUDIT_BASELINE ?? "{}"), storageImbalanceRatio: n("KAFKA_STORAGE_IMBALANCE_RATIO", 0),
    brokers: (env.KAFKA_BROKERS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    addressMap: parseAddressMap(env.KAFKA_BROKER_ADDRESS_MAP ?? "{}"),
    clientId: env.KAFKA_CLIENT_ID ?? "personal-mcp-kafka", tls: env.KAFKA_TLS === "true", ca: env.KAFKA_CA ?? "",
    mechanism: mechanism as KafkaConfig["mechanism"], username: env.KAFKA_USERNAME ?? "", password: env.KAFKA_PASSWORD ?? "",
    timeoutMs: n("KAFKA_TIMEOUT_MS", 10000), maxItems: n("KAFKA_MAX_ITEMS", 1000), maxPartitions: n("KAFKA_MAX_PARTITIONS", 1000),
    concurrency: n("KAFKA_CONCURRENCY", 5), maxResponseBytes: n("KAFKA_MAX_RESPONSE_BYTES", 2097152), maxBrokerResponseBytes: n("KAFKA_MAX_BROKER_RESPONSE_BYTES", 16777216),
  };
}
export function parseBroker(address: string): { host: string; port: number } {
  const match = /^(?:\[([0-9a-fA-F:]+)\]|([^\s:/@?#]+)):(\d+)$/.exec(address);
  const port = Number(match?.[3]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("KAFKA_BROKERS must contain host:port or [IPv6]:port entries");
  return { host: match[1] ?? match[2]!, port };
}
export function parseAddressMap(raw: string): Record<string, string> {
  let value: unknown;
  try { value = JSON.parse(raw || "{}"); } catch { throw new Error("KAFKA_BROKER_ADDRESS_MAP must be a JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("KAFKA_BROKER_ADDRESS_MAP must be a JSON object");
  const entries = Object.entries(value);
  if (entries.length > 1000) throw new Error("Kafka address map supports at most 1000 entries");
  for (const [source, target] of entries) {
    parseBroker(source);
    if (typeof target !== "string") throw new Error("Kafka address map targets must be host:port strings");
    parseBroker(target);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
export function validateKafkaConfig(c: KafkaConfig): void {
  if (c.brokers.length > 20) throw new Error("At most 20 bootstrap brokers are allowed");
  c.brokers.forEach(parseBroker);
  auditBaselineSchema.parse(c.auditBaseline);
  if (!Number.isFinite(c.storageImbalanceRatio) || (c.storageImbalanceRatio !== 0 && (c.storageImbalanceRatio <= 1 || c.storageImbalanceRatio > 1000))) throw new Error("KAFKA_STORAGE_IMBALANCE_RATIO must be 0 (disabled) or greater than 1 and at most 1000");
  parseAddressMap(JSON.stringify(c.addressMap));
  if (!c.clientId || Buffer.byteLength(c.clientId) > 255) throw new Error("Kafka client ID must contain 1..255 bytes");
  for (const [key, value, min, max] of [
    ["timeoutMs", c.timeoutMs, 1, 30000], ["maxItems", c.maxItems, 1, 1000], ["maxPartitions", c.maxPartitions, 1, 10000],
    ["concurrency", c.concurrency, 1, 20], ["maxResponseBytes", c.maxResponseBytes, 4096, 16777216],
    ["maxBrokerResponseBytes", c.maxBrokerResponseBytes, 4096, 67108864],
  ] as const) if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Kafka ${key} must be an integer in ${min}..${max}`);
  if (c.mechanism !== "none" && (!c.username || !c.password)) throw new Error("Kafka SASL requires username and password");
  if (c.mechanism === "none" && (c.username || c.password)) throw new Error("Kafka credentials require a SASL mechanism");
  if (c.ca && !c.tls) throw new Error("Kafka CA requires TLS");
  if (c.ca) { try { if (!c.ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error(); createSecureContext({ ca: c.ca }); } catch { throw new Error("Kafka CA must be a valid PEM certificate"); } }
}
export function kafkaConfigValues(c: KafkaConfig): Record<string, string | number | boolean> {
  return { KAFKA_AUDIT_BASELINE: JSON.stringify(c.auditBaseline), KAFKA_STORAGE_IMBALANCE_RATIO: c.storageImbalanceRatio, KAFKA_BROKER_ADDRESS_MAP: JSON.stringify(c.addressMap), KAFKA_BROKERS: c.brokers.join(","), KAFKA_CLIENT_ID: c.clientId, KAFKA_TLS: c.tls, KAFKA_CA: c.ca,
    KAFKA_SASL_MECHANISM: c.mechanism, KAFKA_USERNAME: c.username, KAFKA_PASSWORD: c.password,
    KAFKA_TIMEOUT_MS: c.timeoutMs, KAFKA_MAX_ITEMS: c.maxItems, KAFKA_MAX_PARTITIONS: c.maxPartitions, KAFKA_CONCURRENCY: c.concurrency,
    KAFKA_MAX_RESPONSE_BYTES: c.maxResponseBytes, KAFKA_MAX_BROKER_RESPONSE_BYTES: c.maxBrokerResponseBytes };
}
