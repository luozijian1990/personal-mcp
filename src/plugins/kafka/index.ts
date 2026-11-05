import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { PersonalMcpPlugin, PersonalMcpPluginMetadata } from "../../core/plugin.js";
import { toolErrorResult, toolStructuredResult } from "../../core/tool-result.js";
import { KAFKA_CONFIG_FIELDS, loadKafkaConfig, validateKafkaConfig, type KafkaConfig } from "./config.js";
import { createKafkaReader, type ReaderFactory } from "./client.js";
import { KafkaQueries } from "./queries.js";
import { safeError, QueryError } from "./protocol.js";
import { overviewOutput, topicsOutput, topicOutput, groupsOutput, describeGroupOutput, lagOutput } from "./output-schemas.js";

export const KAFKA_PLUGIN_METADATA: PersonalMcpPluginMetadata = {
  id: "kafka", displayName: "Kafka", summary: "只读查询 Kafka 集群、Topic、传统消费组与分区级 Lag 快照。",
  category: { id: "messaging", name: "消息队列", description: "查询消息系统的结构与消费状态。" },
};
const titles = { kafka_cluster_overview: "Kafka 集群概览", kafka_list_topics: "列出 Kafka Topics", kafka_describe_topic: "查看 Kafka Topic", kafka_list_groups: "列出 Kafka 消费组", kafka_describe_group: "查看 Kafka 消费组", kafka_get_lag: "查询 Kafka 分区级 Lag" };
export function enforceResponse(config: KafkaConfig, data: object) {
  const result = toolStructuredResult(data);
  if (Buffer.byteLength(JSON.stringify(result)) > config.maxResponseBytes) throw new QueryError("RESPONSE_TOO_LARGE", "Kafka MCP response exceeds budget; narrow the topic/partition filter or list limit");
  return result;
}
export function createKafkaPlugin(options: { config?: KafkaConfig; readerFactory?: ReaderFactory } = {}): PersonalMcpPlugin {
  const config = options.config ?? loadKafkaConfig(); const factory = options.readerFactory ?? createKafkaReader;
  const topic = z.string().min(1).max(249).regex(/^[a-zA-Z0-9._-]+$/).refine(s => s !== "." && s !== "..", "Invalid Kafka topic name");
  const groupId = z.string().min(1).max(1024).refine(s => Buffer.byteLength(s) <= 1024, "Group ID must not exceed 1024 UTF-8 bytes");
  const limit = z.number().int().min(1).max(config.maxItems).default(Math.min(100, config.maxItems));
  const nameFilter = z.string().max(249).default("").describe("Case-sensitive substring, applied locally before truncation");
  return {
    ...KAFKA_PLUGIN_METADATA, config: { fields: KAFKA_CONFIG_FIELDS },
    tools: Object.entries(titles).map(([name, title]) => ({ name, title, risk: "read-only" as const, requiresConfirmation: false, disabledByDefault: false, logging: { input: "metadata" as const, output: "metadata" as const } })),
    checkHealth: async signal => {
      try { validateKafkaConfig(config); if (!config.brokers.length) return { state: "unconfigured", message: "KAFKA_BROKERS is not configured" }; }
      catch { return { state: "unconfigured", message: "Kafka configuration is invalid" }; }
      let reader;
      try { reader = factory(config, signal); const queries = new KafkaQueries(config, reader); await queries.initialize(); const result = await queries.overview(); return { state: result.complete ? "healthy" : "degraded", message: "Bootstrap authentication and metadata probe completed; resource ACLs and all advertised endpoints were not checked" }; }
      catch (e) { return { state: "unhealthy", message: safeError(e).message }; }
      finally { reader?.close(); }
    },
    createServer: () => {
      const server = new McpServer({ name: "kafka-mcp-server", version: "0.1.0" });
      const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
      const run = async (signal: AbortSignal, schema: z.ZodType, action: (q: KafkaQueries) => Promise<object>) => {
        let reader;
        try { validateKafkaConfig(config); reader = factory(config, signal); const q = new KafkaQueries(config, reader); await q.initialize(); const data = await action(q); schema.parse(data); return enforceResponse(config, data); }
        catch (e) { const error = safeError(e); return toolErrorResult(new Error(`${error.code}: ${error.message}`)); }
        finally { reader?.close(); }
      };
      server.registerTool("kafka_cluster_overview", { title: titles.kafka_cluster_overview, description: "Read cluster ID, advertised brokers/racks, client-visible controller and bootstrap API capabilities. API support does not establish per-resource ACL permissions or all-broker health.", inputSchema: z.object({}).strict(), outputSchema: overviewOutput, annotations }, (_, ctx) => run(ctx.mcpReq.signal, overviewOutput, q => q.overview()));
      server.registerTool("kafka_list_topics", { title: titles.kafka_list_topics, description: "List visible topics with internal flags. Fetches metadata before local substring filtering and truncation; ACL-hidden resources are not counted. No topic creation.", inputSchema: z.object({ nameFilter, includeInternal: z.boolean().default(false), limit }).strict(), outputSchema: topicsOutput, annotations }, (args, ctx) => run(ctx.mcpReq.signal, topicsOutput, q => q.listTopics(args)));
      server.registerTool("kafka_describe_topic", { title: titles.kafka_describe_topic, description: "Read one exact topic's partitions, leaders, replicas, ISR, offline replicas and config sources. Defaults to seven troubleshooting configs; includeAllConfigs includes all returned settings, never sensitive values. Structural/config failures are independent.", inputSchema: z.object({ topic, includeAllConfigs: z.boolean().default(false) }).strict(), outputSchema: topicOutput, annotations }, (args, ctx) => run(ctx.mcpReq.signal, topicOutput, q => q.describeTopic(args)));
      server.registerTool("kafka_list_groups", { title: titles.kafka_list_groups, description: "List visible groups from discovered brokers, including available state/protocol/type. Filter and limit are local; newer group types are labelled unsupported. Partial broker errors are retained.", inputSchema: z.object({ nameFilter: z.string().max(1024).default(""), limit }).strict(), outputSchema: groupsOutput, annotations }, (args, ctx) => run(ctx.mcpReq.signal, groupsOutput, q => q.listGroups(args)));
      server.registerTool("kafka_describe_group", { title: titles.kafka_describe_group, description: "Read one classic consumer group's state, coordinator, assignment strategy, members and assigned partitions. New consumer/share protocols are rejected. No join/heartbeat/commit requests.", inputSchema: z.object({ groupId }).strict(), outputSchema: describeGroupOutput, annotations }, (args, ctx) => run(ctx.mcpReq.signal, describeGroupOutput, q => q.describeGroup(args.groupId)));
      server.registerTool("kafka_get_lag", { title: titles.kafka_get_lag, description: "Read one classic group's per-partition start/end/committed offsets and lag, with current member attribution. Decimal strings preserve int64 precision. Missing commits remain null; errors and out-of-range commits are explicit. Non-atomic snapshot, not exact record counts or causal diagnosis. Scope exceeding partition budget is rejected, never sampled. Partitions requires an exact topic.", inputSchema: z.object({ groupId, topic: topic.optional(), partitions: z.array(z.number().int().min(0).max(2147483647)).min(1).max(config.maxPartitions).refine(ps => new Set(ps).size === ps.length, "Duplicate partitions are not allowed").optional(), isolationLevel: z.enum(["read_uncommitted", "read_committed"]).default("read_uncommitted") }).strict().refine(args => !args.partitions || !!args.topic, "partitions requires topic"), outputSchema: lagOutput, annotations }, (args, ctx) => run(ctx.mcpReq.signal, lagOutput, q => q.lag(args)));
      return server;
    },
  };
}
