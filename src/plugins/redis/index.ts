import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { PersonalMcpPlugin, PersonalMcpPluginMetadata } from "../../core/plugin.js";
import { toolErrorResult, toolStructuredResult } from "../../core/tool-result.js";
import { loadRedisConfig, REDIS_CONFIG_FIELDS, validateRedisConfig, type RedisConfig } from "./config.js";
import { withRedis, type RedisReader } from "./client.js";
import { scanOutput, readOutput, inspectOutput, diagnoseOutput, slowlogOutput } from "./output-schemas.js";
import { enforceResponse, keyBytes, RedisQueries, type Result } from "./queries.js";

export const REDIS_PLUGIN_METADATA: PersonalMcpPluginMetadata = {
  id: "redis", displayName: "Redis", summary: "只读查询 Redis 数据、实例状态、慢日志和单 key 内存。",
  category: { id: "databases", name: "数据库", description: "查询和分析数据库数据。" },
};
const titles = {
  redis_scan_keys: "扫描 Redis keys", redis_read_key: "读取 Redis key", redis_inspect_key: "查看类型、TTL 和内存",
  redis_diagnose: "诊断 Redis 实例", redis_get_slowlog: "读取 Redis 慢查询",
};
export function createRedisPlugin(options: { config?: RedisConfig } = {}): PersonalMcpPlugin {
  const config = options.config ?? loadRedisConfig();
  const queries = new RedisQueries(config);
  const db = z.number().int().min(0).max(2147483647).default(config.db).describe("Logical DB for this call; results identify it");
  // Any encoded key that fits a scan response must also fit the read/inspect input.
  const key = z.string().max(Math.max(8192, config.maxResponseBytes)).describe("Exact Redis key, including empty key; encoded character limit is max(8192, REDIS_MAX_RESPONSE_BYTES)");
  const validateKey = (args: { key: string; keyEncoding: "utf8" | "base64" }, ctx: z.RefinementCtx) => {
    try { keyBytes(args.key, args.keyEncoding); } catch { ctx.addIssue({ code: "custom", message: "Key must use canonical Base64", path: ["key"] }); }
  };
  const keyEncoding = z.enum(["utf8", "base64"]).default("utf8");
  const cursor = z.string().uuid().optional().describe("Opaque cursor returned by same tool; retain DB/key/pattern and type");
  const limit = z.number().int().min(1).max(config.maxItems).default(config.maxItems);
  return {
    ...REDIS_PLUGIN_METADATA, config: { fields: REDIS_CONFIG_FIELDS },
    tools: Object.entries(titles).map(([name, title]) => ({ name, title, risk: "read-only" as const, requiresConfirmation: false, disabledByDefault: false, logging: { input: "metadata" as const, output: "metadata" as const } })),
    checkHealth: async signal => {
      try { validateRedisConfig(config); } catch { return { state: "unconfigured", message: "Redis configuration is invalid" }; }
      try {
        await withRedis(config, config.db, signal, r => r.query(["PING"]));
        return { state: "healthy", message: "Redis AUTH/SELECT/PING succeeded; data and diagnostic permissions not checked" };
      } catch (e) { return { state: "unhealthy", message: e instanceof Error ? e.message : "Redis probe failed" }; }
    },
    createServer: () => {
      const server = new McpServer({ name: "redis-mcp-server", version: "0.1.0" });
      const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
      const run = async (selectedDb: number, signal: AbortSignal, action: (reader: RedisReader) => Promise<Result>) => {
        try {
          validateRedisConfig(config);
          const data = await withRedis(config, selectedDb, signal, action);
          return toolStructuredResult(enforceResponse(config, data));
        } catch (e) { return toolErrorResult(e); }
      };
      server.registerTool("redis_scan_keys", {
        title: titles.redis_scan_keys, description: "Bounded SCAN using a Redis glob pattern (e.g. orders:*). Not a snapshot; duplicates possible. Empty page does not mean absent keys unless complete=true. Continue with opaque nextCursor; expired/evicted cursors must restart.",
        inputSchema: z.object({ db, pattern: z.string().max(2048).default("*"), cursor, limit }).strict(), outputSchema: scanOutput, annotations,
      }, (args, ctx) => run(args.db, ctx.mcpReq.signal, r => queries.scan(r, args.db, args)));
      server.registerTool("redis_read_key", {
        title: titles.redis_read_key, description: "Read String/Hash/List/Set/Sorted Set only. String offset/length are bytes; List/Sorted Set offset is zero-based rank. Hash/Set use opaque cursor, offset must be zero. Follow data.nextOffset or nextCursor. Values may be bounded previews; binary bytes use Base64. No script or command execution.",
        inputSchema: z.object({ db, key, keyEncoding, cursor, limit, offset: z.number().int().min(0).max(2147483647).default(0), length: z.number().int().min(1).max(config.maxValueBytes).default(config.maxValueBytes) }).strict().superRefine(validateKey), outputSchema: readOutput, annotations,
      }, (args, ctx) => run(args.db, ctx.mcpReq.signal, r => queries.read(r, args.db, keyBytes(args.key, args.keyEncoding), args)));
      server.registerTool("redis_inspect_key", {
        title: titles.redis_inspect_key, description: "Observe TYPE, PTTL in milliseconds (-1 no expiry, -2 absent) and MEMORY USAGE with five samples. Memory may be unavailable independently; no full DB analysis.",
        inputSchema: z.object({ db, key, keyEncoding }).strict().superRefine(validateKey), outputSchema: inspectOutput, annotations,
      }, (args, ctx) => run(args.db, ctx.mcpReq.signal, r => queries.inspect(r, args.db, keyBytes(args.key, args.keyEncoding))));
      server.registerTool("redis_diagnose", {
        title: titles.redis_diagnose, description: "Read INFO server, clients, memory, stats, persistence, replication and keyspace. Returns per-section availability. Endpoint/node scope only; counters are cumulative and not root-cause conclusions.",
        inputSchema: z.object({ db }).strict(), outputSchema: diagnoseOutput, annotations,
      }, (args, ctx) => run(args.db, ctx.mcpReq.signal, r => queries.diagnose(r, args.db)));
      server.registerTool("redis_get_slowlog", {
        title: titles.redis_get_slowlog, description: "Read newest bounded SLOWLOG GET window; does not consume or reset. Timestamps are Unix seconds, durations microseconds. Arguments hidden unless operator configuration explicitly enables bounded previews; client addresses omitted.",
        inputSchema: z.object({ db, limit }).strict(), outputSchema: slowlogOutput, annotations,
      }, (args, ctx) => run(args.db, ctx.mcpReq.signal, r => queries.slowlog(r, args.db, args.limit)));
      return server;
    },
  };
}
