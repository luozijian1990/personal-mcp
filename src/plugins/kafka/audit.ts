import { z } from "zod/v4";
import type { Metadata } from "./protocol.js";
const positive = z.number().int().positive().safe();
export const auditBaselineSchema = z.object({
  minReplicationFactor: positive.optional(), minMinIsr: positive.optional(),
  maxRetentionMs: positive.optional(), maxRetentionBytes: positive.optional(), maxMessageBytes: positive.optional(),
  allowInfiniteRetention: z.boolean().optional(), cleanupPolicies: z.array(z.enum(["delete", "compact", "compact,delete"])).min(1).optional(),
}).strict();
export type AuditBaseline = z.infer<typeof auditBaselineSchema>;
export interface ConfigEvidence { name: string; value: string | null; sourceCode: number | null; isSensitive: boolean }
export interface Finding {
  rule: string; scope: string; category: "configuration" | "runtime" | "baseline" | "observation";
  severity: "error" | "warning" | "info"; result: "finding" | "insufficient_evidence";
  evidence: string[]; suggestion: string;
}
export function parseAuditBaseline(raw: string): AuditBaseline {
  try { return auditBaselineSchema.parse(JSON.parse(raw || "{}")); } catch { throw new Error("KAFKA_AUDIT_BASELINE must be a JSON object with supported nonnegative policy fields (positive numeric thresholds)"); }
}
export function auditTopic(topic: Metadata["topicMetadata"][number], configs: ConfigEvidence[] | undefined, baseline: AuditBaseline): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: string, category: Finding["category"], severity: Finding["severity"], evidence: string[], suggestion: string, result: Finding["result"] = "finding", partition?: number) => findings.push({ rule, scope: partition === undefined ? topic.topic : `${topic.topic}:${partition}`, category, severity, result, evidence, suggestion });
  const values = new Map(configs?.map(c => [c.name, c.value]));
  const integer = (name: string) => { const value = values.get(name); return value !== undefined && value !== null && /^-?\d+$/.test(value) ? BigInt(value) : undefined; };
  const minIsr = integer("min.insync.replicas");
  if (minIsr === undefined || minIsr < 1n) add("min_isr_evidence", "configuration", "info", ["Effective min.insync.replicas unavailable or invalid"], "Obtain effective topic configuration before evaluating ISR rules", "insufficient_evidence");
  for (const p of topic.partitionMetadata) {
    if (p.partitionErrorCode) { add("partition_evidence", "runtime", "info", [`partitionErrorCode=${p.partitionErrorCode}`], "Resolve the partition query error before evaluating it", "insufficient_evidence", p.partitionId); continue; }
    const replicationFactor = p.replicas.length;
    if (minIsr !== undefined && minIsr >= 1n) {
      if (minIsr > BigInt(replicationFactor)) add("min_isr_exceeds_replicas", "configuration", "error", [`replicas=${replicationFactor}`, `min.insync.replicas=${minIsr}`], "Align replica count and minimum ISR; acks=all writes cannot satisfy this requirement", "finding", p.partitionId);
      if (BigInt(p.isr.length) < minIsr) add("current_isr_below_min", "runtime", "warning", [`isr=${p.isr.length}`, `min.insync.replicas=${minIsr}`], "Inspect replica reachability and replication; acks=all writes may be rejected", "finding", p.partitionId);
    }
    if (p.isr.length < replicationFactor) add("under_replicated", "runtime", "warning", [`replicas=${replicationFactor}`, `isr=${p.isr.length}`], "Inspect replication and broker availability; this snapshot does not establish the cause", "finding", p.partitionId);
    if (replicationFactor === 1) add("single_replica", "observation", "info", ["replicas=1"], "Evaluate the required failure tolerance before changing replica count", "finding", p.partitionId);
    if (p.leader < 0 || (p.offlineReplicas?.length ?? 0) > 0) add("offline_partition_evidence", "runtime", "warning", [`leader=${p.leader}`, `offlineReplicas=${p.offlineReplicas?.join(",") ?? "unknown"}`], "Investigate the observed leader/offline replica state", "finding", p.partitionId);
    if (!topic.isInternal && baseline.minReplicationFactor !== undefined && replicationFactor < baseline.minReplicationFactor) add("replication_baseline", "baseline", "warning", [`replicas=${replicationFactor}`, `minimum=${baseline.minReplicationFactor}`], "Review replica count against the configured baseline", "finding", p.partitionId);
  }
  if (!configs) { add("config_evidence", "configuration", "info", ["Topic configuration query unavailable"], "Check DescribeConfigs permissions and retry", "insufficient_evidence"); return findings; }
  const overrides = configs.filter(c => c.sourceCode === 1).map(c => c.name);
  if (overrides.length) add("topic_overrides", "observation", "info", overrides, "Review intentional overrides; an override alone is not a misconfiguration");
  if (integer("retention.ms") === -1n || integer("retention.bytes") === -1n) add("unbounded_retention_dimension", "observation", "info", [`retention.ms=${values.get("retention.ms")}`, `retention.bytes=${values.get("retention.bytes")}`, `cleanup.policy=${values.get("cleanup.policy")}`], "Interpret time and size retention together with cleanup policy; one unbounded dimension does not imply unlimited storage");
  add("client_configuration_boundary", "observation", "info", ["Producer acks and producer/consumer message-size settings are not available through these admin queries"], "Correlate client configuration separately; no end-to-end configuration guarantee is made", "insufficient_evidence");
  if (topic.isInternal) { add("internal_policy_scope", "observation", "info", ["Business topic baseline not applied to internal topic"], "Use Kafka internal-topic semantics for retention and cleanup decisions"); return findings; }
  const checks: [keyof AuditBaseline, string, "min" | "max"][] = [["minMinIsr", "min.insync.replicas", "min"], ["maxRetentionMs", "retention.ms", "max"], ["maxRetentionBytes", "retention.bytes", "max"], ["maxMessageBytes", "max.message.bytes", "max"]];
  for (const [field, name, direction] of checks) {
    const threshold = baseline[field]; if (typeof threshold !== "number") continue; const actual = integer(name);
    if (actual === undefined) add(`baseline_${field}`, "baseline", "info", [`${name}=unknown`], "Obtain the effective value", "insufficient_evidence");
    else if (direction === "min" ? actual < BigInt(threshold) : actual === -1n || actual > BigInt(threshold)) add(`baseline_${field}`, "baseline", "warning", [`${name}=${actual}`, `threshold=${threshold}`], "Review against the configured baseline and business requirements");
  }
  if (baseline.allowInfiniteRetention === false && integer("retention.ms") === -1n && integer("retention.bytes") === -1n) add("retention_baseline", "baseline", "warning", ["Both retention dimensions are unbounded"], "Review cleanup policy and configured retention requirements");
  if (baseline.cleanupPolicies) {
    const policy = values.get("cleanup.policy")?.split(",").map(s => s.trim()).sort().join(",");
    if (!policy) add("cleanup_baseline", "baseline", "info", ["cleanup.policy=unknown"], "Obtain cleanup policy", "insufficient_evidence");
    else if (!baseline.cleanupPolicies.includes(policy as "delete" | "compact" | "compact,delete")) add("cleanup_baseline", "baseline", "warning", [`cleanup.policy=${policy}`, `allowed=${baseline.cleanupPolicies.join(";")}`], "Review the cleanup policy against the configured baseline");
  }
  return findings;
}
