import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { PersonalMcpPlugin, PersonalMcpPluginMetadata, ToolLoggingPolicy } from "../../core/plugin.js";
import { toolErrorResult, toolStructuredResult } from "../../core/tool-result.js";
import { createElasticsearchReadClient, isRecord, type ElasticsearchReadClient } from "./client.js";
import {
  ELASTICSEARCH_CONFIG_FIELDS,
  loadElasticsearchPluginConfig,
  validateElasticsearchConfig,
  type ElasticsearchPluginConfig,
} from "./config.js";
import {
  ELASTICSEARCH_DEFAULT_LIST_LIMIT,
  ELASTICSEARCH_DEFAULT_MAX_FIELDS,
  ELASTICSEARCH_DEFAULT_SEARCH_SIZE,
  ELASTICSEARCH_HARD_MAX_FIELDS,
  ELASTICSEARCH_HARD_MAX_HITS,
  ELASTICSEARCH_MAX_LIST_LIMIT,
  ELASTICSEARCH_MAX_SAMPLE_SIZE,
  ELASTICSEARCH_PLUGIN_ID,
} from "./constants.js";
import {
  allocationOutputSchema,
  capabilitiesOutputSchema,
  clusterHealthOutputSchema,
  fieldCapsOutputSchema,
  indicesOutputSchema,
  mappingOutputSchema,
  searchOutputSchema,
  shardsOutputSchema,
} from "./output-schemas.js";
import {
  explainAllocation,
  getCapabilities,
  getClusterHealth,
  getFieldCaps,
  getMapping,
  listIndices,
  listShards,
  parseMajor,
  sampleDocuments,
  search,
} from "./queries.js";

export const ELASTICSEARCH_PLUGIN_METADATA: PersonalMcpPluginMetadata = {
  id: ELASTICSEARCH_PLUGIN_ID,
  displayName: "Elasticsearch 7",
  summary: "只读发现 Elasticsearch 7 集群、索引、分片和 Schema，并执行受限 Query DSL 查询。",
  category: {
    id: "operations",
    name: "运维诊断",
    description: "收集基础设施状态与故障排查证据。",
  },
};

const emptyInput = z.object({}).strict();
const indexExpression = z.string().trim().min(1).max(1_024).describe("Elasticsearch index、alias、data stream 或 wildcard expression，例如 logs-*");
const limit = z.number().int().min(1).max(ELASTICSEARCH_MAX_LIST_LIMIT).default(ELASTICSEARCH_DEFAULT_LIST_LIMIT).describe("返回条数，默认 50，最大 200");
const maxFields = z.number().int().min(1).max(ELASTICSEARCH_HARD_MAX_FIELDS).default(ELASTICSEARCH_DEFAULT_MAX_FIELDS).describe("最多返回的字段数量，默认 200，最大 1000");
const jsonObject = z.record(z.string(), z.unknown());

const listIndicesInput = z.object({
  pattern: indexExpression.optional(),
  health: z.enum(["green", "yellow", "red"]).optional(),
  status: z.enum(["open", "close"]).optional(),
  limit,
}).strict();
const listShardsInput = z.object({
  index: indexExpression.optional(),
  state: z.enum(["UNASSIGNED", "INITIALIZING", "STARTED", "RELOCATING"]).optional(),
  node: z.string().trim().min(1).max(256).optional(),
  limit,
}).strict();
const allocationInput = z.object({
  index: indexExpression.optional(),
  shard: z.number().int().nonnegative().optional(),
  primary: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.index === undefined && (value.shard !== undefined || value.primary !== undefined)) {
    context.addIssue({ code: "custom", message: "shard and primary require index" });
  }
  if (value.index !== undefined && (value.shard === undefined || value.primary === undefined)) {
    context.addIssue({ code: "custom", message: "index requires both shard and primary" });
  }
});
const mappingInput = z.object({
  index: indexExpression,
  fieldPattern: z.string().min(1).max(512).optional().describe("可选字段 wildcard，例如 user.*"),
  maxFields,
}).strict();
const fieldCapsInput = z.object({
  index: indexExpression,
  fields: z.array(z.string().trim().min(1).max(512)).max(200).default(["*"]).describe("字段或 wildcard 列表；默认 *"),
  maxFields,
}).strict();
const sampleInput = z.object({
  index: indexExpression,
  size: z.number().int().min(1).max(ELASTICSEARCH_MAX_SAMPLE_SIZE).default(ELASTICSEARCH_MAX_SAMPLE_SIZE),
  source: z.array(z.string().trim().min(1).max(512)).max(100).optional().describe("可选 _source 字段列表"),
  timeField: z.string().trim().min(1).max(512).optional(),
  timeRange: z.object({
    gte: z.string().min(1).max(128).optional(),
    lte: z.string().min(1).max(128).optional(),
  }).strict().refine((value) => value.gte !== undefined || value.lte !== undefined, "timeRange requires gte or lte").optional(),
}).strict();
const searchInput = z.object({
  index: indexExpression,
  query: jsonObject.default({ match_all: {} }),
  sort: z.array(z.union([z.string().min(1).max(512), jsonObject])).max(10).optional(),
  source: z.array(z.string().trim().min(1).max(512)).max(100).optional().describe("可选 _source 字段列表"),
  size: z.number().int().min(0).max(ELASTICSEARCH_HARD_MAX_HITS).default(ELASTICSEARCH_DEFAULT_SEARCH_SIZE),
  aggregations: jsonObject.optional().describe("原生 Elasticsearch 7 aggregation DSL"),
}).strict();

export function createElasticsearchPlugin(options: {
  readonly config?: ElasticsearchPluginConfig;
  readonly client?: ElasticsearchReadClient;
} = {}): PersonalMcpPlugin {
  const config = options.config ?? loadElasticsearchPluginConfig();
  let cachedClient = options.client;
  const client = (): ElasticsearchReadClient => {
    validateElasticsearchConfig(config);
    cachedClient ??= createElasticsearchReadClient(config);
    return cachedClient;
  };

  return {
    ...ELASTICSEARCH_PLUGIN_METADATA,
    tools: [
      toolMeta("elasticsearch_get_capabilities", "Get Elasticsearch capabilities"),
      toolMeta("elasticsearch_cluster_health", "Get Elasticsearch cluster health"),
      toolMeta("elasticsearch_list_indices", "List Elasticsearch indices"),
      toolMeta("elasticsearch_list_shards", "List Elasticsearch shards"),
      toolMeta("elasticsearch_allocation_explain", "Explain Elasticsearch shard allocation"),
      toolMeta("elasticsearch_get_mapping", "Get Elasticsearch mapping fields"),
      toolMeta("elasticsearch_field_caps", "Get Elasticsearch field capabilities"),
      toolMeta("elasticsearch_sample_documents", "Sample Elasticsearch documents", "metadata", "none"),
      toolMeta("elasticsearch_search", "Search Elasticsearch with Query DSL", "metadata", "none"),
    ],
    config: { fields: ELASTICSEARCH_CONFIG_FIELDS },
    checkHealth: async (signal) => {
      if (config.url.length === 0 || (config.username.length === 0) !== (config.password.length === 0)) {
        return { state: "unconfigured" };
      }
      const started = Date.now();
      try {
        validateElasticsearchConfig(config);
        const root = await client().getRoot(signal);
        const version = isRecord(root.version) && typeof root.version.number === "string" ? root.version.number : "unknown";
        if (parseMajor(version) !== 7 || (isRecord(root.version) && root.version.distribution === "opensearch")) {
          return { state: "unhealthy", message: `Unsupported backend ${version}; Elasticsearch 7 is required.`, latencyMs: Date.now() - started };
        }
        const health = await client().getClusterHealth(signal);
        const status = typeof health.status === "string" ? health.status : "unknown";
        const state = status === "green" ? "healthy" : status === "yellow" ? "degraded" : "unhealthy";
        return { state, message: `Elasticsearch ${version}; cluster status ${status}`, latencyMs: Date.now() - started };
      } catch (error) {
        return { state: "unhealthy", message: safeErrorMessage(error), latencyMs: Date.now() - started };
      }
    },
    createServer: () => createServer(config, client),
  };
}

function createServer(config: ElasticsearchPluginConfig, getClient: () => ElasticsearchReadClient): McpServer {
  const server = new McpServer({ name: "elasticsearch-mcp-server", version: "0.1.0" });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool("elasticsearch_get_capabilities", {
    title: "Get Elasticsearch 7 capabilities",
    description: "Identify the backend version and whether this Elasticsearch-7-only Plugin supports it. Query DSL is supported on Elasticsearch 7; ES|QL is always reported unavailable.",
    inputSchema: emptyInput, outputSchema: capabilitiesOutputSchema, annotations,
  }, async (_input, context) => result(() => getCapabilities(getClient(), requestSignal(context))));

  server.registerTool("elasticsearch_cluster_health", {
    title: "Get Elasticsearch cluster health",
    description: "Return a compact Elasticsearch cluster health summary including node, active shard, unassigned shard and pending-task counts. This does not change cluster state.",
    inputSchema: emptyInput, outputSchema: clusterHealthOutputSchema, annotations,
  }, async (_input, context) => result(() => getClusterHealth(getClient(), requestSignal(context))));

  server.registerTool("elasticsearch_list_indices", {
    title: "List Elasticsearch indices",
    description: "List bounded Elasticsearch index summaries with optional wildcard pattern, health and open/close filters. Use a narrow pattern on large clusters.",
    inputSchema: listIndicesInput, outputSchema: indicesOutputSchema, annotations,
  }, async (input, context) => result(() => listIndices(getClient(), config, input, requestSignal(context))));

  server.registerTool("elasticsearch_list_shards", {
    title: "List Elasticsearch shards",
    description: "List bounded primary and replica shard summaries, optionally filtered by index expression, state or node. Use this after cluster health reports unassigned shards.",
    inputSchema: listShardsInput, outputSchema: shardsOutputSchema, annotations,
  }, async (input, context) => result(() => listShards(getClient(), config, input, requestSignal(context))));

  server.registerTool("elasticsearch_allocation_explain", {
    title: "Explain Elasticsearch shard allocation",
    description: "Explain why one exact shard is or is not allocated. With no arguments, Elasticsearch selects an unassigned shard. This calls only the read-only allocation explain API.",
    inputSchema: allocationInput, outputSchema: allocationOutputSchema, annotations,
  }, async (input, context) => result(() => explainAllocation(getClient(), config, input, requestSignal(context))));

  server.registerTool("elasticsearch_get_mapping", {
    title: "Get Elasticsearch mapping fields",
    description: "Flatten Elasticsearch 7 mappings into bounded field/type entries. Use fieldPattern and maxFields instead of requesting an unbounded raw mapping.",
    inputSchema: mappingInput, outputSchema: mappingOutputSchema, annotations,
  }, async (input, context) => result(() => getMapping(getClient(), config, input, requestSignal(context))));

  server.registerTool("elasticsearch_field_caps", {
    title: "Get Elasticsearch field capabilities",
    description: "Discover searchable and aggregatable field types across an index expression. Multiple types are explicitly marked as conflicts so an agent can build valid Query DSL.",
    inputSchema: fieldCapsInput, outputSchema: fieldCapsOutputSchema, annotations,
  }, async (input, context) => result(() => getFieldCaps(getClient(), config, input, requestSignal(context))));

  server.registerTool("elasticsearch_sample_documents", {
    title: "Sample Elasticsearch documents",
    description: "Return at most five recent or arbitrary sample documents for schema exploration. For log/event indices, provide timeField and a bounded timeRange. Document sources are never written to central response logs.",
    inputSchema: sampleInput, outputSchema: searchOutputSchema, annotations,
  }, async (input, context) => result(() => sampleDocuments(getClient(), config, input, requestSignal(context))));

  server.registerTool("elasticsearch_search", {
    title: "Search Elasticsearch with Query DSL",
    description: "Execute bounded Elasticsearch 7 Query DSL with optional sort, _source selection and native aggregations. For log/event indices, include a time range. size above the configured maximum fails; no write or arbitrary REST operation is available.",
    inputSchema: searchInput, outputSchema: searchOutputSchema, annotations,
  }, async (input, context) => result(() => search(getClient(), config, input, requestSignal(context))));

  return server;
}

function toolMeta(
  name: string,
  title: string,
  input: ToolLoggingPolicy = "metadata",
  output: ToolLoggingPolicy = "metadata",
) {
  return { name, title, risk: "read-only" as const, logging: { input, output } };
}

async function result(operation: () => Promise<Record<string, unknown>>) {
  try {
    return toolStructuredResult(await operation());
  } catch (error) {
    return toolErrorResult(new Error(safeErrorMessage(error)), { prefix: "Elasticsearch query failed: " });
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1_024 ? message : `${message.slice(0, 1_024)}…`;
}

function requestSignal(context: unknown): AbortSignal | undefined {
  return isRecord(context) && context.signal instanceof AbortSignal ? context.signal : undefined;
}
