import { z } from "zod/v4";
export const failureSchema = z.object({ scope: z.string(), code: z.string(), message: z.string(), retriable: z.boolean() });
export const brokerOutput = z.object({ nodeId: z.number().int(), host: z.string(), port: z.number().int(), rack: z.string().nullable() });
export const memberOutput = z.object({ memberId: z.string(), groupInstanceId: z.string().nullable(), clientId: z.string(), host: z.string(), assignments: z.array(z.object({ topic: z.string(), partitions: z.array(z.number().int()) })), subscribedTopics: z.array(z.string()), assignmentStatus: z.enum(["available", "unknown"]) });
export const groupOutput = z.object({ groupId: z.string(), groupType: z.literal("classic"), state: z.string(), protocolType: z.string(), assignmentStrategy: z.string().nullable(), coordinator: brokerOutput, members: z.array(memberOutput) });
const base = {
  clusterId: z.string().nullable(), startedAt: z.string(), observedAt: z.string(), complete: z.boolean(), truncated: z.boolean(),
  warnings: z.array(z.string()), errors: z.array(failureSchema),
};
const envelope = <T extends z.ZodType>(data: T) => z.object({ ...base, data });
const page = { returnedCount: z.number().int(), matchedVisibleCount: z.number().int(), filtering: z.literal("local"), visibility: z.literal("authorized-resources-only") };
export const overviewOutput = envelope(z.object({ brokers: z.array(brokerOutput), controller: z.number().int().nullable(), capabilities: z.array(z.object({ query: z.string(), status: z.enum(["available", "not_probed", "unsupported", "unknown"]), scope: z.string(), permission: z.literal("resource-dependent"), minVersion: z.number().int().nullable(), maxVersion: z.number().int().nullable() })) }));
export const topicsOutput = envelope(z.object({ ...page, topics: z.array(z.object({ name: z.string(), isInternal: z.boolean(), errorCode: z.number().int() })) }));
export const topicOutput = envelope(z.object({
  topic: z.string(), isInternal: z.boolean().nullable(), structureStatus: z.enum(["available", "unavailable"]), configStatus: z.enum(["available", "unavailable"]),
  partitions: z.array(z.object({ partition: z.number().int(), leader: z.number().int().nullable(), replicas: z.array(z.number().int()), isr: z.array(z.number().int()), offlineReplicas: z.array(z.number().int()), underReplicated: z.boolean(), errorCode: z.number().int() })),
  configs: z.array(z.object({ name: z.string(), value: z.string().nullable(), source: z.string(), sourceCode: z.number().int().nullable(), isSensitive: z.boolean(), readOnly: z.boolean() })),
}));
export const groupsOutput = envelope(z.object({ ...page, groups: z.array(z.object({ groupId: z.string(), protocolType: z.string(), groupType: z.string().nullable(), state: z.string().nullable(), supported: z.boolean() })) }));
export const describeGroupOutput = envelope(groupOutput);
export const lagPartitionOutput = z.object({ topic: z.string(), partition: z.number().int(), startOffset: z.string().nullable(), endOffset: z.string().nullable(), committedOffset: z.string().nullable(), lag: z.string().nullable(), status: z.enum(["ok", "no_committed_offset", "offset_before_start", "offset_after_end", "query_error", "inconsistent_snapshot"]), consumers: z.array(z.object({ memberId: z.string(), clientId: z.string(), host: z.string() })), assignmentStatus: z.enum(["assigned", "unassigned", "unknown"]), errors: z.array(failureSchema) });
export const lagOutput = envelope(z.object({
  groupId: z.string(), isolationLevel: z.enum(["read_uncommitted", "read_committed"]),
  scope: z.literal("committed-and-assigned-and-subscribed-topics-plus-explicit-filters"),
  membersStatus: z.enum(["available", "unavailable"]), partitions: z.array(lagPartitionOutput),
  summary: z.object({ selectedPartitions: z.number().int(), validPartitions: z.number().int(), unknownPartitions: z.number().int(), errorPartitions: z.number().int(), anomalousPartitions: z.number().int(), validPartitionsLag: z.string(), fullSelectedScopeLag: z.string().nullable() }),
}));
export type Failure = z.infer<typeof failureSchema>;
export type Group = z.infer<typeof groupOutput>;
export type LagPartition = z.infer<typeof lagPartitionOutput>;
