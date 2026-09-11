import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { PersonalMcpPlugin, PersonalMcpPluginMetadata } from "../../core/plugin.js";
import { toolStructuredResult } from "../../core/tool-result.js";
import { JAEGER_CONFIG_FIELDS, type JaegerPluginConfig } from "./config.js";
import { jaegerGet } from "./client.js";
import { normalizedSpanSchema, normalizeSpan, summarize, summarySchema, tracesSchema } from "./trace.js";
import { getServiceTopology, topologyInputSchema, topologyOutputSchema } from "./topology.js";
import { queryRange } from "./time.js";

export const JAEGER_PLUGIN_METADATA: PersonalMcpPluginMetadata = {
  id: "jaeger", displayName: "Jaeger Tracing", summary: "只读查询 Jaeger 服务、操作、Trace、Span 证据和服务拓扑。",
  category: { id: "observability", name: "可观测性", description: "查询应用性能与调用链。" },
};
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const namesSchema = z.array(z.string()).nullable().transform(value => value ?? []);
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) };
const pageOutput = { offset: z.number().int(), hasMore: z.boolean(), nextOffset: z.number().int().nullable() };
function paginate<T>(values: T[], offset: number, limit: number) {
  const items = values.slice(offset, offset + limit);
  const hasMore = offset + items.length < values.length;
  return { items, offset, hasMore, nextOffset: hasMore ? offset + items.length : null };
}
export function createJaegerPlugin(config: JaegerPluginConfig): PersonalMcpPlugin {
  return {
    ...JAEGER_PLUGIN_METADATA,
    config: { fields: JAEGER_CONFIG_FIELDS },
    tools: [
      { name: "jaeger_list_services", title: "列出服务" },
      { name: "jaeger_list_operations", title: "列出服务操作" },
      { name: "jaeger_query_traces", title: "搜索 Trace" },
      { name: "jaeger_get_trace", title: "读取 Trace Span 证据" },
      { name: "jaeger_query_service_topology", title: "查询服务拓扑" },
    ].map(tool => ({ ...tool, risk: "read-only" as const, logging: { input: "metadata" as const, output: "metadata" as const } })),
    checkHealth: async signal => {
      if (!config.url) return { state: "unconfigured", message: "Jaeger Query URL is not configured" };
      try {
        await jaegerGet(config, "services", namesSchema, {}, signal);
        return { state: "healthy", message: "Jaeger Query service listing is reachable" };
      } catch (error) { return { state: "unhealthy", message: error instanceof Error ? error.message : String(error) }; }
    },
    createServer: () => createServer(config),
  };
}
function createServer(config: JaegerPluginConfig): McpServer {
  const server = new McpServer({ name: "jaeger-mcp-server", version: "0.1.0" });
  server.registerTool("jaeger_list_services", {
    description: "列出 Jaeger 已索引的服务名称。获取后按名称排序并本地分页；服务列表不代表当前实例健康。", annotations,
    inputSchema: z.object(page), outputSchema: z.object({ services: z.array(z.string()), totalServices: z.number().int(), ...pageOutput }),
  }, async args => {
    const values = (await jaegerGet(config, "services", namesSchema)).sort();
    const { items, ...paging } = paginate(values, args.offset, args.limit);
    return toolStructuredResult({ services: items, totalServices: values.length, ...paging });
  });
  server.registerTool("jaeger_list_operations", {
    description: "列出指定服务已索引的操作名称。精确服务名取自 jaeger_list_services。按名称排序、本地分页。", annotations,
    inputSchema: z.object({ serviceName: z.string().min(1).max(1024), ...page }),
    outputSchema: z.object({ serviceName: z.string(), operations: z.array(z.string()), totalOperations: z.number().int(), ...pageOutput }),
  }, async args => {
    const values = (await jaegerGet(config, `services/${encodeURIComponent(args.serviceName)}/operations`, namesSchema)).sort();
    const { items, ...paging } = paginate(values, args.offset, args.limit);
    return toolStructuredResult({ serviceName: args.serviceName, operations: items, totalOperations: values.length, ...paging });
  });
  server.registerTool("jaeger_query_traces", {
    description: "搜索服务 Trace 摘要，按开始时间降序返回。时间为 now、now-30m 或带时区 ISO 8601；耗时过滤作用于后端匹配 Span。tags 为后端精确过滤（如 error:true 字符串），不等价于所有错误判据。无后端分页/全量总数；limitReached 仅提示可能还有结果，缩小时间范围继续查。详情用 jaeger_get_trace。", annotations,
    inputSchema: z.object({
      serviceName: z.string().min(1).max(1024), operationName: z.string().min(1).max(2048).optional(),
      start: z.string().default("now-30m"), end: z.string().default("now"),
      minDurationMs: z.number().nonnegative().max(86_400_000).multipleOf(0.001).optional().describe("最小耗时（毫秒），精度 0.001ms（1 微秒）"),
      maxDurationMs: z.number().positive().max(86_400_000).multipleOf(0.001).optional().describe("最大耗时（毫秒），精度 0.001ms（1 微秒）"),
      tags: z.record(z.string().min(1).max(256), z.string().max(4096)).refine(value => Object.keys(value).length <= 50, "At most 50 tags").default({}),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    outputSchema: z.object({ traces: z.array(summarySchema), returnedCount: z.number().int(), requestedLimit: z.number().int(), limitReached: z.boolean(), startTimeUs: z.string(), endTimeUs: z.string() }),
  }, async args => {
    if (args.minDurationMs !== undefined && args.maxDurationMs !== undefined && args.minDurationMs > args.maxDurationMs) throw new Error("minDurationMs must not exceed maxDurationMs");
    const range = queryRange(args.start, args.end);
    const params: Record<string, string> = { ...range, service: args.serviceName, limit: String(args.limit), tags: JSON.stringify(args.tags) };
    if (args.operationName !== undefined) params.operation = args.operationName;
    if (args.minDurationMs !== undefined) params.minDuration = `${args.minDurationMs}ms`;
    if (args.maxDurationMs !== undefined) params.maxDuration = `${args.maxDurationMs}ms`;
    const found = await jaegerGet(config, "traces", tracesSchema, params);
    const traces = found.map(summarize).sort((a, b) => (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0) || a.traceId.localeCompare(b.traceId)).slice(0, args.limit);
    return toolStructuredResult({ traces, returnedCount: traces.length, requestedLimit: args.limit, limitReached: found.length >= args.limit, startTimeUs: range.start, endTimeUs: range.end });
  });
  server.registerTool("jaeger_get_trace", {
    description: "按十六进制 Trace ID 获取完整后端 Trace，再按服务/错误筛选并本地分页。保留 CHILD_OF/FOLLOWS_FROM 引用、process、原始 tags/logs；原始 startTime/duration/log timestamp 为微秒，派生 *Ms 为毫秒。分页或筛选可能缺失父节点，完整关系需不筛选读完所有页。错误证据不等于根因，未采样/未入库/过期 Trace 可能查不到。", annotations,
    inputSchema: z.object({ traceId: z.string().regex(/^(?:[0-9a-fA-F]{16}|[0-9a-fA-F]{32})$/).refine(value => !/^0+$/.test(value), "Trace ID must be nonzero"), serviceName: z.string().min(1).optional(), errorsOnly: z.boolean().default(false), ...page }),
    outputSchema: z.object({ traceId: z.string(), found: z.boolean(), totalSpans: z.number().int(), matchedSpans: z.number().int(), spans: z.array(normalizedSpanSchema), warnings: z.array(z.string()), ...pageOutput }),
  }, async args => {
    const traceId = args.traceId.toLowerCase();
    const found = await jaegerGet(config, `traces/${traceId}`, tracesSchema);
    const trace = found.find(item => item.traceID.toLowerCase().padStart(32, "0") === traceId.padStart(32, "0"));
    if (found.length && !trace) throw new Error("Jaeger returned a different Trace ID");
    const spans = trace ? trace.spans.map(span => normalizeSpan(span, trace)) : [];
    const matched = spans.filter(span => (!args.serviceName || span.serviceName === args.serviceName) && (!args.errorsOnly || span.isError));
    matched.sort((a, b) => a.startTime - b.startTime || a.spanID.localeCompare(b.spanID));
    const { items, ...paging } = paginate(matched, args.offset, args.limit);
    return toolStructuredResult({ traceId: trace?.traceID ?? traceId, found: Boolean(trace), totalSpans: spans.length, matchedSpans: matched.length, spans: items, warnings: trace?.warnings ?? [], ...paging });
  });
  server.registerTool("jaeger_query_service_topology", {
    description: "查询 Jaeger 聚合服务依赖图，返回节点、调用方向与 callCount。默认最近一小时，serviceNames 可筛选直接入边/出边。按 source/target 排序后本地边分页，nodes 仅含当前页端点。后端聚合可能延迟、忽略或粗化时间窗口；采样计数不等于业务总量，空图不证明无依赖。返回结构化图数据，不生成图片。",
    annotations, inputSchema: topologyInputSchema, outputSchema: topologyOutputSchema,
  }, async args => toolStructuredResult(await getServiceTopology(config, args)));
  return server;
}
