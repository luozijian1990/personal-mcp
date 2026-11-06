import type { KafkaReader } from "./client.js";
import type { KafkaConfig } from "./config.js";
import { boundedMap } from "./queries.js";
import { auditTopic, type ConfigEvidence, type Finding } from "./audit.js";
import { metadataSchema, configsSchema, checkCode, safeError, QueryError, type Metadata, type BrokerAddress, type ReadApi } from "./protocol.js";
import { logDirsSchema, quotasSchema, reassignmentsSchema, quorumSchema, type TopicPartitions, type QuotaComponent } from "./admin-protocol.js";
import type { Failure } from "./output-schemas.js";
export interface TopicScope { all: boolean; topics?: string[] | undefined }
export interface StorageScope extends TopicScope { brokerIds?: number[] | undefined }
export type State = "available" | "partial" | "unsupported" | "not_applicable" | "forbidden" | "failed";
export function failureState(code: string): State {
  if (/AUTHORIZATION_FAILED|AUTHENTICATION|DENIED|FORBIDDEN/.test(code)) return "forbidden";
  if (/UNSUPPORTED_VERSION|NOT_IMPLEMENTED|DoesNotSupportApiKey|NotImplemented/.test(code)) return "unsupported";
  if (code === "NOT_APPLICABLE") return "not_applicable";
  return "failed";
}
const configNames = ["retention.ms", "retention.bytes", "cleanup.policy", "min.insync.replicas", "max.message.bytes", "segment.ms", "segment.bytes"];
const brokerConfigNames = ["message.max.bytes", "replica.fetch.max.bytes", "min.insync.replicas", "log.retention.ms", "log.retention.bytes", "log.cleanup.policy", "unclean.leader.election.enable"];
const knownLong = (s: string | null) => s === null || BigInt(s) < 0n ? null : s;
function throwCode(code: number): unknown { try { checkCode(code); } catch (e) { return e; } return new QueryError("INVALID_RESPONSE", "Unexpected response state"); }
export class KafkaAdminQueries {
  private seed!: BrokerAddress;
  private cluster: Metadata | undefined;
  readonly errors: Failure[] = [];
  readonly warnings: string[] = [];
  constructor(private config: KafkaConfig, private reader: KafkaReader) {}
  private fail(scope: string, e: unknown) { const error = { scope, ...safeError(e) }; this.errors.push(error); return error; }
  private async attempt<T>(scope: string, fn: () => Promise<T>): Promise<T | undefined> { try { return await fn(); } catch (e) { this.fail(scope, e); return undefined; } }
  async initialize() {
    this.seed = await this.reader.bootstrap();
    this.cluster = await this.attempt("cluster", async () => metadataSchema.parse(await this.reader.read(this.seed, "Metadata")));
  }
  result<T>(data: T | null) {
    const states = new Set(this.errors.map(e => failureState(e.code)));
    const status: State = data !== null ? (this.errors.length ? "partial" : "available") : states.size === 1 ? [...states][0]! : "failed";
    return { clusterId: this.cluster?.clusterId ?? null, startedAt: this.reader.startedAt, observedAt: new Date().toISOString(), status, complete: status === "available", truncated: false as const, warnings: this.warnings, errors: this.errors, data };
  }
  async execute<T>(fn: () => Promise<T>) {
    try { await this.initialize(); return this.result(await fn()); } catch (e) { this.fail("query", e); return this.result<T>(null); }
  }
  private inventory() {
    if (!this.cluster) {
      const cause = this.errors.find(e => e.scope === "cluster");
      throw new QueryError(cause?.code ?? "CLUSTER_UNAVAILABLE", cause?.message ?? "Broker inventory could not be obtained", cause?.retriable ?? false);
    }
    return this.cluster;
  }
  private checkSize(count: number, max: number, scope: string) { if (count > max) throw new QueryError("SCOPE_TOO_LARGE", `${scope} exceeds configured limit ${max}; narrow the query scope`); }
  private async metadata(scope: TopicScope, includeInternal: boolean, brokerIds?: number[]) {
    const m = metadataSchema.parse(await this.reader.read(this.seed, "Metadata", { topics: scope.all || !scope.topics ? [] : scope.topics }));
    if (scope.topics) for (const name of scope.topics) if (!m.topicMetadata.some(t => t.topic === name)) this.fail(`topic:${name}`, new QueryError("MISSING_TOPIC", "Requested topic omitted from metadata"));
    if (!includeInternal && scope.topics) for (const t of m.topicMetadata) {
      if (t.isInternal && scope.topics.includes(t.topic)) this.fail(`topic:${t.topic}`, new QueryError("INTERNAL_TOPIC_EXCLUDED", "Requested internal topic was excluded; set includeInternal=true to audit it"));
    }
    m.topicMetadata = m.topicMetadata.filter(t => (!scope.topics || scope.topics.includes(t.topic)) && (includeInternal || !t.isInternal));
    // Metadata may be cluster-wide on the wire; item budgets apply to the selected broker scope.
    if (brokerIds) m.topicMetadata = m.topicMetadata.map(t => ({ ...t, partitionMetadata: t.partitionMetadata.filter(p => p.partitionErrorCode !== 0 || p.replicas.some(id => brokerIds.includes(id))) }))
      .filter(t => !!scope.topics || t.topicErrorCode !== 0 || t.partitionMetadata.length > 0);
    this.checkSize(m.topicMetadata.length, this.config.maxItems, "Topics");
    this.checkSize(m.topicMetadata.reduce((n, t) => n + t.partitionMetadata.length, 0), this.config.maxPartitions, "Partitions");
    for (const t of m.topicMetadata) {
      if (t.topicErrorCode) this.fail(`topic:${t.topic}`, throwCode(t.topicErrorCode));
      for (const p of t.partitionMetadata) if (p.partitionErrorCode) this.fail(`partition:${t.topic}:${p.partitionId}`, throwCode(p.partitionErrorCode));
    }
    return m;
  }
  private async configs(broker: BrokerAddress, name: string, type: number, names: string[]): Promise<ConfigEvidence[]> {
    const response = configsSchema.parse(await this.reader.read(broker, "DescribeConfigs", { includeSynonyms: false, resources: [{ type, name, configNames: names }] }));
    const resource = response.resources.find(r => r.resourceName === name); if (!resource) throw new QueryError("MISSING_RESOURCE", "Requested config resource omitted"); checkCode(resource.errorCode);
    return resource.configEntries.filter(c => names.includes(c.configName)).map(c => ({ name: c.configName, value: c.isSensitive ? null : c.configValue, sourceCode: c.configSource ?? null, isSensitive: c.isSensitive }));
  }
  async audit(scope: TopicScope & { includeInternal: boolean; includeBrokerConfigs: boolean }) {
    const m = await this.metadata(scope, scope.includeInternal);
    const findings: Finding[] = [];
    const topics = await boundedMap(m.topicMetadata, this.config.concurrency, async t => {
      const configs = t.topicErrorCode ? undefined : await this.attempt(`configs:${t.topic}`, () => this.configs(this.seed, t.topic, 2, configNames));
      if (!t.topicErrorCode) findings.push(...auditTopic(t, configs, this.config.auditBaseline));
      return { topic: t.topic, isInternal: t.isInternal, configStatus: configs ? "available" : failureState(this.errors.find(e => e.scope === `configs:${t.topic}` || e.scope === `topic:${t.topic}`)?.code ?? "FAILED"), configs: configs ?? [] };
    });
    const brokerConfigs: { brokerId: number; configs: ConfigEvidence[] }[] = [];
    if (scope.includeBrokerConfigs) {
      const ids = new Set(m.topicMetadata.flatMap(t => t.partitionMetadata.flatMap(p => p.replicas)));
      this.checkSize(ids.size, this.config.maxItems, "Related brokers");
      await boundedMap([...ids], this.config.concurrency, async id => {
        const value = await this.attempt(`broker-configs:${id}`, async () => { const broker = m.brokers.find(b => b.nodeId === id); if (!broker) throw new QueryError("BROKER_UNAVAILABLE", "Related broker missing from metadata"); return this.configs(broker, String(id), 4, brokerConfigNames); });
        if (value) brokerConfigs.push({ brokerId: id, configs: value });
      });
      for (const broker of brokerConfigs) {
        const values = new Map(broker.configs.map(c => [c.name, c.value]));
        const message = values.get("message.max.bytes"), fetch = values.get("replica.fetch.max.bytes");
        if (message && fetch && /^\d+$/.test(message) && /^\d+$/.test(fetch) && BigInt(fetch) < BigInt(message)) findings.push({
          rule: "broker_fetch_size_relationship", scope: `broker:${broker.brokerId}`, category: "observation", severity: "info", result: "finding",
          evidence: [`message.max.bytes=${message}`, `replica.fetch.max.bytes=${fetch}`],
          suggestion: "Review replication fetch sizing with topic overrides and actual batch sizes; modern Kafka may return an oversized first batch, so this is not proof of blocked replication",
        });
      }
      for (const name of brokerConfigNames) {
        const observed = brokerConfigs.map(b => ({ brokerId: b.brokerId, value: b.configs.find(c => c.name === name)?.value }));
        if (new Set(observed.filter(v => v.value !== undefined && v.value !== null).map(v => v.value)).size > 1) findings.push({ rule: "broker_config_difference", scope: name, category: "observation", severity: "info", result: "finding", evidence: observed.map(v => `broker ${v.brokerId}: ${v.value ?? "unknown"}`), suggestion: "Review whether the difference is intentional; different brokers need not have identical configuration" });
      }
    } else findings.push({ rule: "broker_configs_not_requested", scope: "brokers", category: "observation", severity: "info", result: "insufficient_evidence", evidence: ["includeBrokerConfigs=false"], suggestion: "Enable broker configuration inspection for cross-broker evidence" });
    this.warnings.push("Rules evaluate observed effective configuration, not producer/consumer configuration or business intent. Internal topics skip business baselines. Findings never execute or generate change commands.");
    return { baseline: this.config.auditBaseline, scope: scope.all ? scope.includeInternal ? "all_visible" : "all_visible_non_internal" : "selected_topics", includeBrokerConfigs: scope.includeBrokerConfigs, topics, brokerConfigs: brokerConfigs.sort((a,b) => a.brokerId-b.brokerId), findings, hasInsufficientEvidence: findings.some(f => f.result === "insufficient_evidence") };
  }
  async storage(scope: StorageScope) {
    const inventory = this.inventory();
    const ids = scope.brokerIds ?? inventory.brokers.map(b => b.nodeId);
    this.checkSize(ids.length, this.config.maxItems, "Brokers");
    for (const id of ids) if (!inventory.brokers.some(b => b.nodeId === id)) throw new QueryError("UNKNOWN_BROKER", "Requested Broker ID is not in cluster metadata");
    const metadata = await this.metadata({ all: !scope.topics, ...(scope.topics ? { topics: scope.topics } : {}) }, true, scope.brokerIds);
    const requested: TopicPartitions[] | null = scope.topics ? metadata.topicMetadata.filter(t => !t.topicErrorCode).map(t => ({ topic: t.topic, partitions: t.partitionMetadata.map(p => p.partitionId) })) : null;
    const expected = new Set(metadata.topicMetadata.flatMap(t => t.partitionMetadata.flatMap(p => p.replicas.filter(id => ids.includes(id)).map(id => JSON.stringify([id, t.topic, p.partitionId])))));
    this.checkSize(expected.size, this.config.maxPartitions, "Storage replica scope");
    const directories: { brokerId: number; path: string; status: State; errorCode: number; totalBytes: string | null; usableBytes: string | null; currentBytes: string; futureBytes: string; replicas: {topic: string; partition: number; sizeBytes: string | null; offsetLag: string | null; isFuture: boolean}[] }[] = [];
    const successful = new Set<number>(); const seen = new Set<string>(); let observedReplicas = 0;
    let scopeExceeded: QueryError | undefined;
    await boundedMap(ids, this.config.concurrency, async id => {
      if (scopeExceeded) return;
      const response = await this.attempt(`storage:${id}`, async () => { const value = logDirsSchema.parse(await this.reader.read(inventory.brokers.find(b => b.nodeId === id)!, "DescribeLogDirs", { topics: requested })); checkCode(value.errorCode); if (!value.directories.length) throw new QueryError("EMPTY_LOG_DIRS", "Broker returned no log directories; permission or support cannot be inferred"); return value; });
      if (!response || scopeExceeded) return;
      const returnedReplicas = response.directories.reduce((n, d) => n + d.replicas.filter(p => !scope.topics || scope.topics.includes(p.topic)).length, 0);
      try {
        this.checkSize(observedReplicas + returnedReplicas, this.config.maxPartitions, "Returned storage replicas");
        this.checkSize(directories.length + response.directories.length, this.config.maxItems, "Log directories");
      } catch (e) { scopeExceeded = e as QueryError; return; }
      observedReplicas += returnedReplicas;
      successful.add(id);
      for (const d of response.directories) {
        if (d.errorCode) this.fail(`directory:${id}:${d.path}`, throwCode(d.errorCode));
        let current = 0n, future = 0n;
        const replicas = d.replicas.filter(p => !scope.topics || scope.topics.includes(p.topic)).map(p => {
          const sizeBytes = knownLong(p.sizeBytes); if (sizeBytes === null) this.fail(`replica:${id}:${p.topic}:${p.partition}`, new QueryError("UNKNOWN_REPLICA_SIZE", "Replica size unavailable"));
          if (sizeBytes !== null && !d.errorCode) { if (p.isFuture) future += BigInt(sizeBytes); else { const replicaKey = JSON.stringify([id,p.topic,p.partition]); if (seen.has(replicaKey)) this.fail(`replica:${replicaKey}`, new QueryError("DUPLICATE_REPLICA", "Current replica reported in multiple directories; distribution is not reliable")); current += BigInt(sizeBytes); seen.add(replicaKey); } }
          return { ...p, sizeBytes, offsetLag: knownLong(p.offsetLag) };
        });
        directories.push({ brokerId: id, path: d.path, status: d.errorCode ? failureState(safeError(throwCode(d.errorCode)).code) : "available", errorCode: d.errorCode, totalBytes: knownLong(d.totalBytes), usableBytes: knownLong(d.usableBytes), currentBytes: current.toString(), futureBytes: future.toString(), replicas });
      }
    });
    if (scopeExceeded) throw scopeExceeded;
    if (successful.size === 0) return null;
    this.checkSize(observedReplicas, this.config.maxPartitions, "Returned storage replicas");
    this.checkSize(directories.length, this.config.maxItems, "Log directories");
    for (const k of expected) if (!seen.has(k)) this.fail(`replica:${k}`, new QueryError("MISSING_REPLICA", "Replica from metadata absent in successful log-directory responses; snapshot may have changed"));
    const distribution = [...successful].sort((a,b)=>a-b).map(brokerId => {
      const ds = directories.filter(d => d.brokerId === brokerId && !d.errorCode);
      return { brokerId, currentBytes: ds.reduce((s,d)=>s+BigInt(d.currentBytes),0n).toString(), futureBytes: ds.reduce((s,d)=>s+BigInt(d.futureBytes),0n).toString(), replicaCount: ds.reduce((n,d)=>n+d.replicas.filter(p=>!p.isFuture).length,0), futureReplicaCount: ds.reduce((n,d)=>n+d.replicas.filter(p=>p.isFuture).length,0), shareOfObservedCurrentBytes: null as number | null };
    });
    const total = distribution.reduce((s,d)=>s+BigInt(d.currentBytes),0n); const max = distribution.reduce((s,d)=>BigInt(d.currentBytes)>s?BigInt(d.currentBytes):s,0n);
    for (const d of distribution) d.shareOfObservedCurrentBytes = total ? Number(BigInt(d.currentBytes)*1000000n/total)/1000000 : null;
    const comparable = this.errors.length === 0 && distribution.length === ids.length && ids.length >= 2 && total > 0n;
    const ratio = comparable ? Number(max*BigInt(ids.length))/Number(total) : null;
    const threshold = this.config.storageImbalanceRatio || null;
    // Compare the configured decimal threshold exactly; display rounding must not change the verdict.
    const [whole, fraction = ""] = String(threshold ?? 0).split(".");
    const thresholdScale = 10n ** BigInt(fraction.length);
    const thresholdUnits = BigInt(`${whole}${fraction}`);
    const aboveThreshold = comparable && threshold !== null && max * BigInt(ids.length) * thresholdScale > total * thresholdUnits;
    this.warnings.push("Replica log bytes are not total filesystem usage, traffic, remote-tier storage or capacity-normalized load. Volume capacities are per directory and must not be summed; directories may share a volume.", "Future replica bytes are reported separately. Distribution shares use only observed successful current replica bytes. Partial data suppresses overall imbalance judgment.");
    return { scope: scope.all ? "all_visible" : scope.topics ? scope.brokerIds ? "selected_brokers_and_topics" : "selected_topics" : "selected_brokers", includesInternal: true as const, brokerIds: ids, directories, distribution, comparison: { threshold, maxToMeanRatio: ratio, status: !comparable ? "insufficient_data" : threshold === null ? "not_configured" : aboveThreshold ? "above_threshold" : "within_threshold", scope: "selected_brokers_and_topics", capacityNormalized: false as const } };
  }
  async quotas(args: { all: boolean; components?: { entityType: "user" | "client-id"; match: "exact" | "default" | "any"; name?: string | undefined }[] | undefined; strict: boolean; includeDefaults: boolean }) {
    const components: QuotaComponent[] = (args.components ?? []).map(c=>({entityType:c.entityType,matchType:c.match==="exact"?0:c.match==="default"?1:2,match:c.match==="exact"?c.name!:null}));
    const requests: { components: QuotaComponent[]; strict: boolean }[] = [{components,strict:args.strict}];
    if (!args.all && args.includeDefaults) {
      const defaults: QuotaComponent[] = ["user","client-id"].map(entityType=>({entityType:entityType as "user"|"client-id",matchType:1,match:null}));
      requests.push(...defaults.map(d=>({components:[d],strict:true})),{components:defaults,strict:true});
      for (const c of components.filter(c=>c.matchType===0)) { requests.push({components:[c],strict:true}); requests.push({components:[c,defaults.find(d=>d.entityType!==c.entityType)!],strict:true}); }
    }
    const uniqueRequests = [...new Map(requests.map(r=>[JSON.stringify(r),r])).values()];
    const results = await boundedMap(uniqueRequests,this.config.concurrency,r=>this.attempt("quotas",async()=>{const response=quotasSchema.parse(await this.reader.read(this.seed,"DescribeClientQuotas",r));checkCode(response.errorCode);return response.entries;}));
    if (results.every(r=>r===undefined)) return null;
    const entries=[...new Map(results.flatMap(r=>r??[]).map(e=>[JSON.stringify([...e.entity].sort((a,b)=>a.type.localeCompare(b.type))),e])).values()];
    this.checkSize(entries.length,this.config.maxItems,"Quota entities");
    this.warnings.push("Results are configured quota entities and optional default candidates, not a resolved effective quota for a specific authenticated request. An empty result does not prove unlimited traffic. No throttle/latency metrics are queried.");
    return { includesDefaultCandidates: args.includeDefaults || args.all, effectiveQuotaResolved:false as const, strict:args.strict, entries:entries.map(e=>({...e,values:e.values.map(v=>({...v,unit:v.key==="producer_byte_rate"||v.key==="consumer_byte_rate"?"bytes_per_second":v.key==="request_percentage"?"percentage":"quota_specific"}))})) };
  }
  async reassignments(scope: TopicScope) {
    const m = await this.metadata(scope,true);
    const controller = this.inventory().brokers.find(b=>b.nodeId===this.inventory().controllerId);
    if (!controller) throw new QueryError("CONTROLLER_UNAVAILABLE","Controller address unavailable in broker metadata");
    const topics = scope.all ? null : m.topicMetadata.filter(t=>!t.topicErrorCode).map(t=>({topic:t.topic,partitions:t.partitionMetadata.map(p=>p.partitionId)}));
    const response=reassignmentsSchema.parse(await this.reader.read(controller,"ListPartitionReassignments",{topics,timeout:this.config.timeoutMs}));checkCode(response.errorCode);
    const partitions=response.topics.filter(t=>!scope.topics||scope.topics.includes(t.topic)).flatMap(t=>t.partitions.map(p=>({topic:t.topic,...p})));
    this.checkSize(partitions.length,this.config.maxPartitions,"Reassigning partitions");
    this.warnings.push("Snapshot of ongoing reassignments only. No completion percentage, duration or stalled-migration diagnosis is available.");
    return {scope:scope.all?"all_visible":"selected_topics",partitions,progressAvailable:false as const};
  }
  async quorum() {
    const response=quorumSchema.parse(await this.reader.read(this.seed,"DescribeQuorum"));checkCode(response.errorCode);
    const p=response.topics.find(t=>t.topic==="__cluster_metadata")?.partitions.find(p=>p.partition===0);
    if(!p)throw new QueryError("MISSING_QUORUM","Metadata quorum partition was omitted");checkCode(p.errorCode);
    const leader=p.voters.find(v=>v.replicaId===p.leaderId); const leaderOffset=leader?knownLong(leader.logEndOffset):null;
    const member=(v:typeof p.voters[number])=>{const offset=knownLong(v.logEndOffset);return{...v,logEndOffset:offset,lastFetchTimestamp:knownLong(v.lastFetchTimestamp),lastCaughtUpTimestamp:knownLong(v.lastCaughtUpTimestamp),lagBehindLeader:offset!==null&&leaderOffset!==null?(BigInt(leaderOffset)-BigInt(offset)).toString():null};};
    const observations:string[]=[];if(p.leaderId<0)observations.push("leader_unknown");if(p.leaderId>=0&&!leader)observations.push("leader_not_in_returned_voters");if(p.voters.some(v=>knownLong(v.logEndOffset)===null))observations.push("voter_offset_unknown");
    this.warnings.push("Broker-routed quorum snapshot only; no direct controller connection. Offsets/timestamps may be unknown or non-atomic. An unsupported API or failed request does not establish ZooKeeper mode. No majority-liveness or root-cause conclusion is inferred.");
    return {topic:"__cluster_metadata" as const,partition:0 as const,leaderId:p.leaderId<0?null:p.leaderId,leaderEpoch:p.leaderEpoch,highWatermark:knownLong(p.highWatermark),voters:p.voters.map(member),observers:p.observers.map(member),observations,timestampUnit:"unix_milliseconds" as const};
  }
}
