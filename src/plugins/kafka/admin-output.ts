import { z } from "zod/v4";
import { failureSchema } from "./output-schemas.js";
import { auditBaselineSchema } from "./audit.js";
const integer = z.number().int();
const long = z.string().regex(/^-?\d+$/);
export const availability = z.enum(["available", "partial", "unsupported", "not_applicable", "forbidden", "failed"]);
const envelope = <T extends z.ZodType>(data: T) => z.object({ clusterId: z.string().nullable(), startedAt: z.string(), observedAt: z.string(), status: availability, complete: z.boolean(), truncated: z.literal(false), warnings: z.array(z.string()), errors: z.array(failureSchema), data: data.nullable() });
export const configEvidenceSchema = z.object({ name: z.string(), value: z.string().nullable(), sourceCode: integer.nullable(), isSensitive: z.boolean() });
const finding = z.object({ rule: z.string(), scope: z.string(), category: z.enum(["configuration", "runtime", "baseline", "observation"]), severity: z.enum(["error", "warning", "info"]), result: z.enum(["finding", "insufficient_evidence"]), evidence: z.array(z.string()), suggestion: z.string() });
export const auditOutput = envelope(z.object({ baseline: auditBaselineSchema, scope: z.enum(["selected_topics", "all_visible_non_internal", "all_visible"]), includeBrokerConfigs: z.boolean(), topics: z.array(z.object({ topic: z.string(), isInternal: z.boolean(), configStatus: availability, configs: z.array(configEvidenceSchema) })), brokerConfigs: z.array(z.object({ brokerId: integer, configs: z.array(configEvidenceSchema) })), findings: z.array(finding), hasInsufficientEvidence: z.boolean() }));
const replica = z.object({ topic: z.string(), partition: integer, sizeBytes: long.nullable(), offsetLag: long.nullable(), isFuture: z.boolean() });
const distribution = z.object({ brokerId: integer, currentBytes: long, futureBytes: long, replicaCount: integer, futureReplicaCount: integer, shareOfObservedCurrentBytes: z.number().nullable() });
export const storageOutput = envelope(z.object({
  scope: z.enum(["all_visible", "selected_brokers", "selected_topics", "selected_brokers_and_topics"]), includesInternal: z.literal(true), brokerIds: z.array(integer),
  directories: z.array(z.object({ brokerId: integer, path: z.string(), status: availability, errorCode: integer, totalBytes: long.nullable(), usableBytes: long.nullable(), currentBytes: long, futureBytes: long, replicas: z.array(replica) })),
  distribution: z.array(distribution), comparison: z.object({ threshold: z.number().nullable(), maxToMeanRatio: z.number().nullable(), status: z.enum(["not_configured", "insufficient_data", "within_threshold", "above_threshold"]), scope: z.literal("selected_brokers_and_topics"), capacityNormalized: z.literal(false) }),
}));
export const quotaOutput = envelope(z.object({ includesDefaultCandidates: z.boolean(), effectiveQuotaResolved: z.literal(false), strict: z.boolean(), entries: z.array(z.object({ entity: z.array(z.object({ type: z.string(), name: z.string().nullable() })), values: z.array(z.object({ key: z.string(), value: z.number().finite(), unit: z.string() })) })) }));
export const reassignmentsOutput = envelope(z.object({ scope: z.enum(["selected_topics", "all_visible"]), partitions: z.array(z.object({ topic: z.string(), partition: integer, replicas: z.array(integer), addingReplicas: z.array(integer), removingReplicas: z.array(integer) })), progressAvailable: z.literal(false) }));
const quorumReplica = z.object({ replicaId: integer, logEndOffset: long.nullable(), lastFetchTimestamp: long.nullable(), lastCaughtUpTimestamp: long.nullable(), lagBehindLeader: long.nullable() });
export const quorumOutput = envelope(z.object({ topic: z.literal("__cluster_metadata"), partition: z.literal(0), leaderId: integer.nullable(), leaderEpoch: integer, highWatermark: long.nullable(), voters: z.array(quorumReplica), observers: z.array(quorumReplica), observations: z.array(z.string()), timestampUnit: z.literal("unix_milliseconds") }));
