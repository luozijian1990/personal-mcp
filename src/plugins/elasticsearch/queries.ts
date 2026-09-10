import type { ElasticsearchPluginConfig } from "./config.js";
import type { ElasticsearchReadClient, JsonRecord } from "./client.js";
import { isRecord, validateIndexExpression } from "./client.js";
import { fitItems, fitObject, fitSearchResult } from "./response-limit.js";

export interface SearchInput {
  readonly index: string;
  readonly query: JsonRecord;
  readonly sort?: readonly (string | JsonRecord)[] | undefined;
  readonly source?: readonly string[] | undefined;
  readonly size: number;
  readonly aggregations?: JsonRecord | undefined;
}

export async function getCapabilities(
  client: ElasticsearchReadClient,
  signal?: AbortSignal,
): Promise<JsonRecord> {
  const root = await client.getRoot(signal);
  const version = isRecord(root.version) && typeof root.version.number === "string"
    ? root.version.number
    : "unknown";
  const major = parseMajor(version);
  const distribution = isRecord(root.version) && typeof root.version.distribution === "string"
    ? root.version.distribution
    : "elasticsearch";
  return {
    version,
    distribution,
    supported: major === 7 && distribution !== "opensearch",
    queryDsl: major === 7 && distribution !== "opensearch",
    esql: false,
    message: major === 7 && distribution !== "opensearch"
      ? "Elasticsearch 7 is supported; ES|QL is unavailable in Elasticsearch 7."
      : `This Plugin supports Elasticsearch 7 only; backend reported ${distribution} ${version}.`,
  };
}

export async function getClusterHealth(
  client: ElasticsearchReadClient,
  signal?: AbortSignal,
): Promise<JsonRecord> {
  const health = await client.getClusterHealth(signal);
  return pick(health, [
    "cluster_name",
    "status",
    "number_of_nodes",
    "number_of_data_nodes",
    "active_primary_shards",
    "active_shards",
    "relocating_shards",
    "initializing_shards",
    "unassigned_shards",
    "delayed_unassigned_shards",
  ], { pending_tasks: health.number_of_pending_tasks ?? null });
}

export async function listIndices(
  client: ElasticsearchReadClient,
  config: ElasticsearchPluginConfig,
  input: { readonly pattern?: string | undefined; readonly health?: string | undefined; readonly status?: string | undefined; readonly limit: number },
  signal?: AbortSignal,
): Promise<JsonRecord> {
  if (input.pattern !== undefined) validateIndexExpression(input.pattern);
  const rows = await client.listIndices(input.pattern, signal);
  const filtered = rows.filter((row) => (
    (input.health === undefined || row.health === input.health)
    && (input.status === undefined || row.status === input.status)
  )).sort((left, right) => String(left.index ?? "").localeCompare(String(right.index ?? "")));
  const items = filtered.slice(0, input.limit).map((row) => ({
    index: asString(row.index),
    health: nullableString(row.health),
    status: nullableString(row.status),
    primaryShards: asInteger(row.pri),
    replicas: asInteger(row.rep),
    docsCount: nullableInteger(row["docs.count"]),
    storeBytes: nullableInteger(row["store.size"]),
  }));
  return fitItems({ totalCount: filtered.length }, "indices", items, config.maxResponseBytes, filtered.length > items.length);
}

export async function listShards(
  client: ElasticsearchReadClient,
  config: ElasticsearchPluginConfig,
  input: { readonly index?: string | undefined; readonly state?: string | undefined; readonly node?: string | undefined; readonly limit: number },
  signal?: AbortSignal,
): Promise<JsonRecord> {
  if (input.index !== undefined) validateIndexExpression(input.index);
  const rows = await client.listShards(input.index, signal);
  const filtered = rows.filter((row) => (
    (input.state === undefined || String(row.state ?? "").toUpperCase() === input.state)
    && (input.node === undefined || row.node === input.node)
  ));
  const items = filtered.slice(0, input.limit).map((row) => ({
    index: asString(row.index),
    shard: asInteger(row.shard),
    primary: row.prirep === "p",
    state: asString(row.state),
    node: nullableString(row.node),
    docs: nullableInteger(row.docs),
    storeBytes: nullableInteger(row.store),
    unassignedReason: nullableString(row["unassigned.reason"]),
  }));
  return fitItems({ totalCount: filtered.length }, "shards", items, config.maxResponseBytes, filtered.length > items.length);
}

export async function explainAllocation(
  client: ElasticsearchReadClient,
  config: ElasticsearchPluginConfig,
  input: { readonly index?: string | undefined; readonly shard?: number | undefined; readonly primary?: boolean | undefined },
  signal?: AbortSignal,
): Promise<JsonRecord> {
  if (input.index !== undefined) validateIndexExpression(input.index);
  const requested = input.index === undefined ? {} : {
    index: input.index,
    ...(input.shard === undefined ? {} : { shard: input.shard }),
    ...(input.primary === undefined ? {} : { primary: input.primary }),
  };
  const response = await client.explainAllocation(requested, signal);
  const result = pick(response, [
    "index",
    "shard",
    "primary",
    "current_state",
    "unassigned_info",
    "can_allocate",
    "allocate_explanation",
    "configured_delay_in_millis",
    "remaining_delay_in_millis",
    "node_allocation_decisions",
  ]);
  return fitObject(result, config.maxResponseBytes, ["node_allocation_decisions"]);
}

export async function getMapping(
  client: ElasticsearchReadClient,
  config: ElasticsearchPluginConfig,
  input: { readonly index: string; readonly fieldPattern?: string | undefined; readonly maxFields: number },
  signal?: AbortSignal,
): Promise<JsonRecord> {
  validateIndexExpression(input.index);
  const response = await client.getMapping(input.index, signal);
  const matcher = input.fieldPattern === undefined ? undefined : wildcardMatcher(input.fieldPattern);
  const fields: JsonRecord[] = [];
  for (const [index, indexValue] of Object.entries(response).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isRecord(indexValue) || !isRecord(indexValue.mappings)) continue;
    const mappingRoots = mappingPropertyRoots(indexValue.mappings);
    for (const properties of mappingRoots) flattenProperties(index, "", properties, fields, matcher);
  }
  fields.sort((left, right) => `${left.index}.${left.field}`.localeCompare(`${right.index}.${right.field}`));
  const selected = fields.slice(0, input.maxFields);
  return fitItems({ matchedFields: fields.length }, "fields", selected, config.maxResponseBytes, fields.length > selected.length);
}

export async function getFieldCaps(
  client: ElasticsearchReadClient,
  config: ElasticsearchPluginConfig,
  input: { readonly index: string; readonly fields: readonly string[]; readonly maxFields: number },
  signal?: AbortSignal,
): Promise<JsonRecord> {
  validateIndexExpression(input.index);
  const response = await client.getFieldCaps(input.index, input.fields, signal);
  const rawFields = isRecord(response.fields) ? response.fields : {};
  const items = Object.entries(rawFields).sort(([left], [right]) => left.localeCompare(right)).flatMap(([field, value]) => {
    if (!isRecord(value)) return [];
    const types = Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).flatMap(([type, capability]) => {
      if (!isRecord(capability)) return [];
      return [{
        type,
        searchable: capability.searchable === true,
        aggregatable: capability.aggregatable === true,
        ...(Array.isArray(capability.indices) ? { indices: strings(capability.indices) } : {}),
        ...(Array.isArray(capability.non_searchable_indices) ? { nonSearchableIndices: strings(capability.non_searchable_indices) } : {}),
        ...(Array.isArray(capability.non_aggregatable_indices) ? { nonAggregatableIndices: strings(capability.non_aggregatable_indices) } : {}),
      }];
    });
    return [{ field, types, conflict: types.length > 1 }];
  });
  const selected = items.slice(0, input.maxFields);
  return fitItems({ matchedFields: items.length }, "fields", selected, config.maxResponseBytes, items.length > selected.length);
}

export async function sampleDocuments(
  client: ElasticsearchReadClient,
  config: ElasticsearchPluginConfig,
  input: {
    readonly index: string;
    readonly size: number;
    readonly source?: readonly string[] | undefined;
    readonly timeField?: string | undefined;
    readonly timeRange?: { readonly gte?: string | undefined; readonly lte?: string | undefined } | undefined;
  },
  signal?: AbortSignal,
): Promise<JsonRecord> {
  validateIndexExpression(input.index);
  if ((input.timeField === undefined) !== (input.timeRange === undefined)) {
    throw new Error("timeField and timeRange must be provided together");
  }
  const query = input.timeField === undefined ? { match_all: {} } : {
    range: { [input.timeField]: input.timeRange },
  };
  const body: JsonRecord = {
    query,
    size: input.size,
    track_total_hits: false,
    ...(input.source === undefined ? {} : { _source: input.source }),
    ...(input.timeField === undefined ? {} : { sort: [{ [input.timeField]: "desc" }] }),
    timeout: `${config.requestTimeoutMs}ms`,
  };
  const response = await client.search({ index: input.index, body }, signal);
  return normalizeSearchResponse(response, config.maxResponseBytes, false);
}

export async function search(
  client: ElasticsearchReadClient,
  config: ElasticsearchPluginConfig,
  input: SearchInput,
  signal?: AbortSignal,
): Promise<JsonRecord> {
  validateIndexExpression(input.index);
  if (input.size > config.maxHits) {
    throw new Error(`size ${input.size} exceeds ELASTICSEARCH_MCP_MAX_HITS (${config.maxHits})`);
  }
  const body: JsonRecord = {
    query: input.query,
    size: input.size,
    timeout: `${config.requestTimeoutMs}ms`,
    track_total_hits: true,
    ...(input.sort === undefined ? {} : { sort: input.sort }),
    ...(input.source === undefined ? {} : { _source: input.source }),
    ...(input.aggregations === undefined ? {} : { aggs: input.aggregations }),
  };
  const response = await client.search({ index: input.index, body }, signal);
  return normalizeSearchResponse(response, config.maxResponseBytes, true);
}

export function parseMajor(version: string): number | undefined {
  const match = /^(\d+)\./u.exec(version);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function normalizeSearchResponse(response: JsonRecord, maximumBytes: number, includeTotal: boolean): JsonRecord {
  const hitsObject = isRecord(response.hits) ? response.hits : {};
  const rawHits = Array.isArray(hitsObject.hits) ? hitsObject.hits : [];
  const hits = rawHits.filter(isRecord).map((hit) => pick(hit, ["_index", "_id", "_score", "_source", "sort", "highlight"]));
  const rawTotal = hitsObject.total;
  const total = isRecord(rawTotal)
    ? { value: asInteger(rawTotal.value), relation: asString(rawTotal.relation) }
    : { value: nullableInteger(rawTotal), relation: "eq" };
  const base: JsonRecord = {
    status: "complete",
    tookMs: asInteger(response.took),
    timedOut: response.timed_out === true,
    ...(includeTotal ? { total } : {}),
    hits,
    ...(isRecord(response.aggregations) ? { aggregations: response.aggregations } : {}),
    ...(Array.isArray(response._shards) || !isRecord(response._shards) ? {} : { shards: response._shards }),
  };
  return fitSearchResult(base, maximumBytes);
}

function mappingPropertyRoots(mappings: JsonRecord): readonly JsonRecord[] {
  const roots: JsonRecord[] = [];
  if (isRecord(mappings.properties)) roots.push(mappings.properties);
  for (const value of Object.values(mappings)) {
    if (isRecord(value) && isRecord(value.properties)) roots.push(value.properties);
  }
  return roots;
}

function flattenProperties(
  index: string,
  prefix: string,
  properties: JsonRecord,
  output: JsonRecord[],
  matcher: RegExp | undefined,
): void {
  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue;
    const field = prefix.length === 0 ? name : `${prefix}.${name}`;
    if (matcher === undefined || matcher.test(field)) {
      output.push({
        index,
        field,
        type: typeof raw.type === "string" ? raw.type : isRecord(raw.properties) ? "object" : "unknown",
        ...(raw.enabled === false ? { enabled: false } : {}),
        ...(typeof raw.index === "boolean" ? { indexed: raw.index } : {}),
      });
    }
    if (isRecord(raw.properties)) flattenProperties(index, field, raw.properties, output, matcher);
    if (isRecord(raw.fields)) flattenMultiFields(index, field, raw.fields, output, matcher);
  }
}

function flattenMultiFields(index: string, parent: string, fields: JsonRecord, output: JsonRecord[], matcher: RegExp | undefined): void {
  for (const [name, raw] of Object.entries(fields)) {
    if (!isRecord(raw)) continue;
    const field = `${parent}.${name}`;
    if (matcher === undefined || matcher.test(field)) {
      output.push({ index, field, type: typeof raw.type === "string" ? raw.type : "unknown", multiField: true });
    }
  }
}

function wildcardMatcher(pattern: string): RegExp {
  if (pattern.length > 512 || /[\u0000-\u001f\u007f]/u.test(pattern)) throw new Error("fieldPattern is invalid or too long");
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "u");
}

function pick(source: JsonRecord, keys: readonly string[], extra: JsonRecord = {}): JsonRecord {
  const entries = keys.flatMap((key) => Object.hasOwn(source, key) && source[key] !== undefined ? [[key, source[key]] as const] : []);
  return { ...Object.fromEntries(entries), ...extra };
}

function strings(value: readonly unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function nullableString(value: unknown): string | null {
  const text = asString(value);
  return text === "" || text === "-" ? null : text;
}

function asInteger(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) ? number : 0;
}

function nullableInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === "-") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
