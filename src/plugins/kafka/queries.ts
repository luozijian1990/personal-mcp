import type { KafkaConfig } from "./config.js";
import type { KafkaReader } from "./client.js";
import { checkCode, configsSchema, coordinatorSchema, decodeAssignment, decodeSubscription, groupSchema, groupsSchema, metadataSchema, offsetsSchema, QueryError, READ_APIS, safeError, type BrokerAddress, type Metadata } from "./protocol.js";
import type { Failure, Group, LagPartition } from "./output-schemas.js";

export const COMMON_CONFIGS = ["retention.ms", "retention.bytes", "cleanup.policy", "min.insync.replicas", "max.message.bytes", "segment.ms", "segment.bytes"];
const sources: Record<number, string> = { 0: "UNKNOWN", 1: "DYNAMIC_TOPIC_CONFIG", 2: "DYNAMIC_BROKER_CONFIG", 3: "DYNAMIC_DEFAULT_BROKER_CONFIG", 4: "STATIC_BROKER_CONFIG", 5: "DEFAULT_CONFIG", 6: "DYNAMIC_BROKER_LOGGER_CONFIG" };
const brokerOut = (b: BrokerAddress) => ({ ...b, rack: b.rack ?? null });
const key = (topic: string, partition: number) => JSON.stringify([topic, partition]);
export async function boundedMap<T, R>(values: T[], concurrency: number, fn: (v: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, async () => { for (;;) { const i = index++; if (i >= values.length) break; result[i] = await fn(values[i]!); } }));
  return result;
}
export function calculateLag(start: string | null, end: string | null, committed: string | null): Pick<LagPartition, "lag" | "status"> {
  if (start === null || end === null) return { lag: null, status: "query_error" };
  if (BigInt(start) > BigInt(end)) return { lag: null, status: "inconsistent_snapshot" };
  if (committed === null) return { lag: null, status: "no_committed_offset" };
  const lag = (BigInt(end) - BigInt(committed)).toString();
  return { lag, status: BigInt(committed) < BigInt(start) ? "offset_before_start" : BigInt(committed) > BigInt(end) ? "offset_after_end" : "ok" };
}
export class KafkaQueries {
  readonly errors: Failure[] = [];
  readonly warnings: string[] = [];
  private clusterId: string | null = null;
  private seed!: BrokerAddress;
  private cluster: Metadata | undefined;
  constructor(private config: KafkaConfig, private r: KafkaReader) {}
  private fail(scope: string, error: unknown): Failure { const failure = { scope, ...safeError(error) }; this.errors.push(failure); return failure; }
  private async attempt<T>(scope: string, fn: () => Promise<T>): Promise<T | undefined> { try { return await fn(); } catch (e) { this.fail(scope, e); return undefined; } }
  async initialize() {
    this.seed = await this.r.bootstrap();
    this.cluster = await this.attempt("cluster", async () => metadataSchema.parse(await this.r.read(this.seed, "Metadata")));
    this.clusterId = this.cluster?.clusterId ?? null;
  }
  finish<T extends object>(data: T, truncated = false) {
    return { clusterId: this.clusterId, startedAt: this.r.startedAt, observedAt: new Date().toISOString(), complete: !truncated && this.errors.length === 0, truncated, warnings: this.warnings, errors: this.errors, data };
  }
  async overview() {
    if (!this.cluster) throw new QueryError("CLUSTER_UNAVAILABLE", "Cluster metadata unavailable; inspect Kafka connectivity and permissions");
    const versions = await this.attempt("capabilities", () => this.r.versions(this.seed));
    this.warnings.push("API version support is not an ACL check. Topic/group permissions are verified only when those resources are queried.", "Controller is the client-visible metadata controller ID; not a KRaft quorum inventory. No broker-wide reachability probe was performed.");
    return this.finish({ brokers: this.cluster.brokers.map(brokerOut), controller: this.cluster.controllerId < 0 ? null : this.cluster.controllerId,
      capabilities: Object.entries(READ_APIS).map(([query, api]) => ({ query, status: !versions ? "unknown" : !versions[api] ? "unsupported" : query === "Metadata" ? "available" : "not_probed", scope: "bootstrap-broker", permission: "resource-dependent", minVersion: versions?.[api]?.minVersion ?? null, maxVersion: versions?.[api]?.maxVersion ?? null })) });
  }
  async listTopics(args: { nameFilter: string; includeInternal: boolean; limit: number }) {
    const m = metadataSchema.parse(await this.r.read(this.seed, "Metadata", { topics: [] }));
    const topics = m.topicMetadata.filter(t => t.topic.includes(args.nameFilter) && (args.includeInternal || !t.isInternal)).sort((a, b) => a.topic.localeCompare(b.topic));
    for (const t of topics) if (t.topicErrorCode) this.fail(`topic:${t.topic}`, codeError(t.topicErrorCode));
    this.warnings.push("Metadata is fetched for all visible topics before local filtering; empty results do not prove cluster-wide absence.");
    return this.finish({ topics: topics.slice(0, args.limit).map(t => ({ name: t.topic, isInternal: t.isInternal, errorCode: t.topicErrorCode })), returnedCount: Math.min(topics.length, args.limit), matchedVisibleCount: topics.length, filtering: "local", visibility: "authorized-resources-only" }, topics.length > args.limit);
  }
  async describeTopic(args: { topic: string; includeAllConfigs: boolean }) {
    const [structure, configuration] = await Promise.all([
      this.attempt("topic:structure", async () => {
        const m = metadataSchema.parse(await this.r.read(this.seed, "Metadata", { topics: [args.topic] }));
        const t = m.topicMetadata.find(t => t.topic === args.topic); if (!t) throw new QueryError("MISSING_TOPIC", "Requested topic was not returned"); checkCode(t.topicErrorCode); return t;
      }),
      this.attempt("topic:configs", async () => {
        const response = configsSchema.parse(await this.r.read(this.seed, "DescribeConfigs", { includeSynonyms: false, resources: [{ type: 2, name: args.topic, ...(!args.includeAllConfigs ? { configNames: COMMON_CONFIGS } : {}) }] }));
        const resource = response.resources.find(r => r.resourceName === args.topic); if (!resource) throw new QueryError("MISSING_RESOURCE", "Requested configuration resource was not returned"); checkCode(resource.errorCode); return resource;
      }),
    ]);
    if (!structure && !configuration) throw new QueryError("TOPIC_QUERY_FAILED", `Topic structure and configuration unavailable (${this.errors.map(e => e.code).join(", ")})`);
    const partitions = structure?.partitionMetadata.map(p => {
      if (p.partitionErrorCode) this.fail(`partition:${p.partitionId}`, codeError(p.partitionErrorCode));
      return { partition: p.partitionId, leader: p.leader < 0 ? null : p.leader, replicas: p.replicas, isr: p.isr, offlineReplicas: p.offlineReplicas ?? [], underReplicated: p.isr.length < p.replicas.length, errorCode: p.partitionErrorCode };
    }) ?? [];
    return this.finish({ topic: args.topic, isInternal: structure?.isInternal ?? null, structureStatus: structure ? "available" : "unavailable", configStatus: configuration ? "available" : "unavailable", partitions,
      configs: configuration?.configEntries.map(c => ({ name: c.configName, value: c.isSensitive ? null : c.configValue, source: c.configSource === undefined ? "UNKNOWN" : sources[c.configSource] ?? "UNKNOWN", sourceCode: c.configSource ?? null, isSensitive: c.isSensitive, readOnly: c.readOnly })) ?? [] });
  }
  private async listOn(address: BrokerAddress) { const result = groupsSchema.parse(await this.r.read(address, "ListGroups")); checkCode(result.errorCode); return result.groups; }
  async listGroups(args: { nameFilter: string; limit: number }) {
    if (!this.cluster) throw new QueryError("CLUSTER_UNAVAILABLE", "Broker inventory is required to list groups");
    const responses = await boundedMap(this.cluster.brokers, this.config.concurrency, b => this.attempt(`broker:${b.nodeId}`, () => this.listOn(b)));
    if (responses.length && responses.every(v => v === undefined)) throw new QueryError("GROUP_LIST_FAILED", `No broker group listing succeeded (${this.errors.map(e => e.code).join(", ")})`);
    const unique = new Map(responses.flatMap(v => v ?? []).map(g => [g.groupId, g]));
    const groups = [...unique.values()].filter(g => g.groupId.includes(args.nameFilter)).sort((a, b) => a.groupId.localeCompare(b.groupId));
    this.warnings.push("Lists are fetched from all discovered brokers before local filtering. ACLs may hide groups without an error. Unknown state is not Empty.");
    return this.finish({ groups: groups.slice(0, args.limit).map(g => ({ groupId: g.groupId, protocolType: g.protocolType, groupType: g.groupType ?? "classic", state: g.groupState ?? null, supported: (!g.groupType || g.groupType.toLowerCase() === "classic") && ["", "consumer"].includes(g.protocolType) })), returnedCount: Math.min(groups.length, args.limit), matchedVisibleCount: groups.length, filtering: "local", visibility: "authorized-resources-only" }, groups.length > args.limit);
  }
  private async coordinator(groupId: string) {
    const response = coordinatorSchema.parse(await this.r.read(this.seed, "FindCoordinator", { groupId, coordinatorType: 0 })); checkCode(response.errorCode); return response.coordinator;
  }
  private async assertClassic(address: BrokerAddress, groupId: string) {
    const versions = await this.r.versions(address);
    if ((versions[16]?.maxVersion ?? 0) >= 5) {
      // DescribeGroups alone can expose modern groups through a compatibility view.
      // Check explicit type on the coordinator before using classic offset semantics.
      const groups = await this.listOn(address); const group = groups.find(g => g.groupId === groupId);
      if (!group) throw new QueryError("GROUP_TYPE_UNVERIFIED", "Group type could not be verified on its coordinator; check group visibility or retry after rebalance");
      if (group.groupType?.toLowerCase() !== "classic") throw new QueryError("UNSUPPORTED_GROUP_TYPE", "Only classic consumer groups are supported; modern consumer/share/streams groups are not supported");
    }
  }
  private async members(address: BrokerAddress, groupId: string): Promise<Group> {
    const response = groupSchema.parse(await this.r.read(address, "DescribeGroups", { groupIds: [groupId] }));
    const g = response.groups.find(g => g.groupId === groupId); if (!g) throw new QueryError("MISSING_GROUP", "Requested group was not returned"); checkCode(g.errorCode);
    if (g.state === "Dead") throw new QueryError("GROUP_NOT_FOUND", "Consumer group is absent or Dead");
    if (!["", "consumer"].includes(g.protocolType)) throw new QueryError("UNSUPPORTED_GROUP_TYPE", "Only classic consumer protocol groups are supported");
    const members = g.members.map(m => {
      let assignments: ReturnType<typeof decodeAssignment> = []; let subscribedTopics: string[] = []; let assignmentStatus: "available" | "unknown" = "available";
      try { assignments = decodeAssignment(m.memberAssignment); subscribedTopics = decodeSubscription(m.memberMetadata); } catch (e) { assignmentStatus = "unknown"; this.fail(`member:${m.memberId}`, e); }
      return { memberId: m.memberId, groupInstanceId: m.groupInstanceId ?? null, clientId: m.clientId, host: m.clientHost, assignments, subscribedTopics, assignmentStatus };
    });
    this.warnings.push("Member assignments are a non-atomic snapshot; groupInstanceId is null when not supplied by the broker.");
    if (g.state !== "Stable" && g.state !== "Empty") this.warnings.push(`Group state ${g.state}: assignments may be transient during rebalance.`);
    return { groupId, groupType: "classic", state: g.state, protocolType: g.protocolType, assignmentStrategy: g.protocol || null, coordinator: brokerOut(address), members };
  }
  async describeGroup(groupId: string) { const address = await this.coordinator(groupId); await this.assertClassic(address, groupId); return this.finish(await this.members(address, groupId)); }

  async lag(args: { groupId: string; topic?: string | undefined; partitions?: number[] | undefined; isolationLevel: "read_uncommitted" | "read_committed" }) {
    const address = await this.coordinator(args.groupId); await this.assertClassic(address, args.groupId);
    let scopedMetadata: Metadata | undefined;
    let fetchTopics: { topic: string; partitions: { partition: number }[] }[] = [];
    if (args.topic) {
      scopedMetadata = metadataSchema.parse(await this.r.read(this.seed, "Metadata", { topics: [args.topic] }));
      const t = scopedMetadata.topicMetadata.find(t => t.topic === args.topic);
      if (!t) throw new QueryError("MISSING_TOPIC", "Requested topic was not returned");
      checkCode(t.topicErrorCode);
      const ids = args.partitions ?? t.partitionMetadata.map(p => p.partitionId);
      if (ids.length > this.config.maxPartitions) throw new QueryError("SCOPE_TOO_LARGE", `Selected ${ids.length} partitions; narrow the partition filter`);
      fetchTopics = [{ topic: args.topic, partitions: ids.map(partition => ({ partition })) }];
    }
    const [group, committed] = await Promise.all([
      this.attempt("group:members", () => this.members(address, args.groupId)),
      this.attempt("group:committed-offsets", async () => { const o = offsetsSchema.parse(await this.r.read(address, "OffsetFetch", { groupId: args.groupId, topics: fetchTopics })); checkCode(o.errorCode ?? 0); return o; }),
    ]);
    if (this.errors.some(e => e.code === "UNSUPPORTED_GROUP_TYPE" || ["GROUP_NOT_FOUND", "GROUP_ID_NOT_FOUND"].includes(e.code))) throw new QueryError("GROUP_UNAVAILABLE", "Group is absent or does not use the supported classic consumer protocol");
    if (!group && !committed && !args.topic) throw new QueryError("LAG_SCOPE_UNKNOWN", "Cannot discover group partitions; both membership and committed-offset queries failed");
    const names = new Set<string>(args.topic ? [args.topic] : [
      ...(committed?.responses.map(t => t.topic) ?? []),
      ...(group?.members.flatMap(m => [...m.subscribedTopics, ...m.assignments.map(a => a.topic)]) ?? []),
    ]);
    // Avoid unbounded fan-out even before partition metadata is available.
    if (names.size > this.config.maxPartitions) throw new QueryError("SCOPE_TOO_LARGE", "Too many topics; specify one topic or increase KAFKA_MAX_PARTITIONS");
    const metadata = scopedMetadata ?? (names.size ? await this.attempt("lag:metadata", async () => metadataSchema.parse(await this.r.read(this.seed, "Metadata", { topics: [...names] }))) : undefined);
    const selected = new Map<string, { topic: string; partition: number; leader?: number; error?: Failure }>();
    const include = (topic: string, partition: number) => (!args.topic || topic === args.topic) && (!args.partitions || args.partitions.includes(partition));
    const add = (topic: string, partition: number) => { if (include(topic, partition) && !selected.has(key(topic, partition))) selected.set(key(topic, partition), { topic, partition }); };
    committed?.responses.forEach(t => t.partitions.forEach(p => add(t.topic, p.partition)));
    group?.members.forEach(m => m.assignments.forEach(t => t.partitions.forEach(p => add(t.topic, p))));
    if (args.topic && args.partitions) args.partitions.forEach(p => add(args.topic!, p));
    metadata?.topicMetadata.forEach(t => {
      if (!names.has(t.topic)) return;
      if (t.topicErrorCode) this.fail(`topic:${t.topic}`, codeError(t.topicErrorCode));
    });
    if (metadata) for (const topic of names) {
      if (!metadata.topicMetadata.some(t => t.topic === topic)) this.fail(`topic:${topic}`, new QueryError("MISSING_TOPIC", "Requested topic was omitted from metadata"));
    }
    // Preserve committed/assigned partitions absent from metadata as explicit errors.
    for (const t of metadata?.topicMetadata ?? []) for (const p of t.partitionMetadata) {
      if (!names.has(t.topic) || !include(t.topic, p.partitionId)) continue;
      add(t.topic, p.partitionId); const item = selected.get(key(t.topic, p.partitionId))!; item.leader = p.leader;
      if (t.topicErrorCode || p.partitionErrorCode) item.error = this.fail(`partition:${t.topic}:${p.partitionId}`, codeError(t.topicErrorCode || p.partitionErrorCode));
    }
    if (selected.size > this.config.maxPartitions) throw new QueryError("SCOPE_TOO_LARGE", `Selected ${selected.size} partitions, exceeding ${this.config.maxPartitions}; specify topic/partitions. No offset range queries were sent`);
    const byLeader = new Map<number, { topic: string; partition: number }[]>();
    for (const item of selected.values()) {
      if (item.error) continue;
      if (item.leader === undefined || item.leader < 0) { item.error = this.fail(`partition:${item.topic}:${item.partition}`, new QueryError("LEADER_UNAVAILABLE", "Partition leader/metadata unavailable", true)); continue; }
      const list = byLeader.get(item.leader) ?? []; list.push(item); byLeader.set(item.leader, list);
    }
    const starts = new Map<string, string>(); const ends = new Map<string, string>(); const rangeErrors = new Map<string, Failure[]>();
    const tasks = [...byLeader.entries()].flatMap(([leader, items]) => [-2, -1].map(timestamp => ({ leader, items, timestamp })));
    await boundedMap(tasks, this.config.concurrency, async ({ leader, items, timestamp }) => {
      const scope = timestamp === -2 ? "start-offset" : "end-offset";
      try {
        const b = metadata?.brokers.find(b => b.nodeId === leader) ?? this.cluster?.brokers.find(b => b.nodeId === leader);
        if (!b) throw new QueryError("BROKER_UNAVAILABLE", "Leader broker address unavailable");
        const topics = new Map<string, { partition: number; timestamp: number }[]>();
        items.forEach(i => { const ps = topics.get(i.topic) ?? []; ps.push({ partition: i.partition, timestamp }); topics.set(i.topic, ps); });
        const result = offsetsSchema.parse(await this.r.read(b, "ListOffsets", { replicaId: -1, isolationLevel: args.isolationLevel === "read_committed" ? 1 : 0, topics: [...topics].map(([topic, partitions]) => ({ topic, partitions })) }));
        const returned = new Map(result.responses.flatMap(t => t.partitions.map(p => [key(t.topic, p.partition), p] as const)));
        for (const item of items) {
          const k = key(item.topic, item.partition); const p = returned.get(k);
          try { if (!p) throw new QueryError("MISSING_PARTITION", "Offset response omitted requested partition"); checkCode(p.errorCode); if (BigInt(p.offset) < 0n) throw new QueryError("OFFSET_UNAVAILABLE", "Broker returned an unknown offset"); (timestamp === -2 ? starts : ends).set(k, p.offset); }
          catch (e) { const errors = rangeErrors.get(k) ?? []; errors.push(this.fail(`${scope}:${item.topic}:${item.partition}`, e)); rangeErrors.set(k, errors); }
        }
      } catch (e) { const f = this.fail(`${scope}:broker:${leader}`, e); items.forEach(i => { const k = key(i.topic, i.partition); rangeErrors.set(k, [...(rangeErrors.get(k) ?? []), f]); }); }
    });
    const commits = new Map(committed?.responses.flatMap(t => t.partitions.map(p => [key(t.topic, p.partition), p] as const)) ?? []);
    const membersAvailable = !!group && group.members.every(m => m.assignmentStatus === "available");
    const partitions: LagPartition[] = [...selected.values()].sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition).map(item => {
      const k = key(item.topic, item.partition); const c = commits.get(k);
      const errors = [...(item.error ? [item.error] : []), ...(rangeErrors.get(k) ?? [])];
      if (committed && args.topic && !c) errors.push(this.fail(`committed:${item.topic}:${item.partition}`, new QueryError("MISSING_PARTITION", "OffsetFetch omitted an explicitly requested partition")));
      if (c && !c.errorCode && BigInt(c.offset) < -1n) errors.push(this.fail(`committed:${item.topic}:${item.partition}`, new QueryError("INVALID_OFFSET", "Unexpected negative committed offset")));
      if (c?.errorCode) errors.push(this.fail(`committed:${item.topic}:${item.partition}`, codeError(c.errorCode)));
      if (!committed) errors.push(...this.errors.filter(e => e.scope === "group:committed-offsets"));
      const startOffset = starts.get(k) ?? null; const endOffset = ends.get(k) ?? null;
      const committedOffset = c && !c.errorCode && BigInt(c.offset) >= 0n ? c.offset : null;
      const consumers = group?.members.filter(m => m.assignmentStatus === "available" && m.assignments.some(a => a.topic === item.topic && a.partitions.includes(item.partition))).map(m => ({ memberId: m.memberId, clientId: m.clientId, host: m.host })) ?? [];
      const assignmentStatus = !membersAvailable ? "unknown" : consumers.length ? "assigned" : group?.state === "Stable" || group?.state === "Empty" ? "unassigned" : "unknown";
      return { topic: item.topic, partition: item.partition, startOffset, endOffset, committedOffset,
        ...(errors.length ? { lag: null, status: "query_error" as const } : calculateLag(startOffset, endOffset, committedOffset)), consumers, assignmentStatus, errors };
    });
    const valid = partitions.filter(p => p.status === "ok");
    const total = valid.reduce((sum, p) => sum + BigInt(p.lag!), 0n).toString();
    this.warnings.push("Lag is endOffset minus committedOffset, not an exact record count or processing position. Queries are not an atomic snapshot.", "Scope is discovered from commits, assignments and subscriptions plus explicit filters. Inactive groups with no commits cannot reveal historical subscriptions.");
    return this.finish({ groupId: args.groupId, isolationLevel: args.isolationLevel, scope: "committed-and-assigned-and-subscribed-topics-plus-explicit-filters", membersStatus: membersAvailable ? "available" : "unavailable", partitions,
      summary: { selectedPartitions: partitions.length, validPartitions: valid.length, unknownPartitions: partitions.filter(p => p.status === "no_committed_offset").length, errorPartitions: partitions.filter(p => p.status === "query_error").length, anomalousPartitions: partitions.filter(p => ["offset_before_start", "offset_after_end", "inconsistent_snapshot"].includes(p.status)).length, validPartitionsLag: total, fullSelectedScopeLag: partitions.length > 0 && valid.length === partitions.length && this.errors.length === 0 ? total : null } });
  }
}
function codeError(code: number): unknown { try { checkCode(code); } catch (e) { return e; } return new QueryError("UNKNOWN_ERROR", "Unknown Kafka error"); }
