import { z } from "zod/v4";
import { jaegerGet } from "./client.js";
import type { JaegerPluginConfig } from "./config.js";
import { queryRange } from "./time.js";

export const topologyInputSchema = z.object({
  start: z.string().default("now-1h"), end: z.string().default("now"),
  serviceNames: z.array(z.string().min(1).max(1024)).max(100).default([]).describe("精确服务名；空数组返回全局依赖。非空保留任一端匹配的直接入边/出边，不递归展开。"),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
});
const edgeSchema = z.object({ source: z.string(), target: z.string(), callCount: z.number().int().nonnegative().safe() });
export const topologyOutputSchema = z.object({
  source: z.literal("jaeger-dependencies"), requestedStartTimeMs: z.number(), requestedEndTimeMs: z.number(),
  nodes: z.array(z.object({ id: z.string(), name: z.string() })), edges: z.array(edgeSchema),
  totalEdges: z.number().int(), matchedEdges: z.number().int(), offset: z.number().int(), hasMore: z.boolean(), nextOffset: z.number().int().nullable(),
  warnings: z.array(z.string()),
});
const dependenciesSchema = z.array(z.object({ parent: z.string(), child: z.string(), callCount: z.number().int().nonnegative().safe() })).nullable();

export async function getServiceTopology(config: JaegerPluginConfig, args: z.infer<typeof topologyInputSchema>) {
  const range = queryRange(args.start, args.end);
  const start = Number(range.start) / 1000, end = Number(range.end) / 1000;
  if (start >= end) throw new Error("Topology start must be earlier than end");
  const links = await jaegerGet(config, "dependencies", dependenciesSchema, { endTs: String(end), lookback: String(end - start) }) ?? [];
  const services = new Set(args.serviceNames);
  const matched = links.filter(link => !services.size || services.has(link.parent) || services.has(link.child));
  matched.sort((a, b) => a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child));
  const edges = matched.slice(args.offset, args.offset + args.limit).map(link => ({ source: link.parent, target: link.child, callCount: link.callCount }));
  const nodes = [...new Set(edges.flatMap(edge => [edge.source, edge.target]))].sort().map(name => ({ id: name, name }));
  const hasMore = args.offset + edges.length < matched.length;
  return {
    source: "jaeger-dependencies" as const, requestedStartTimeMs: start, requestedEndTimeMs: end,
    nodes, edges, totalEdges: links.length, matchedEdges: matched.length, offset: args.offset, hasMore, nextOffset: hasMore ? args.offset + edges.length : null,
    warnings: [
      "依赖来自 Jaeger 后端聚合；时间窗口精度、更新延迟和可用性取决于存储及依赖计算配置。请求时间不证明后端严格按该窗口过滤。",
      "callCount 是后端依赖计数，受采样和保留期影响，不等于真实业务请求总量；空结果不证明服务之间没有调用。",
      "nodes 仅包含当前页 edges 的端点；不包含孤立服务。完整返回图需读完所有页，后端数据可能在查询间变化。",
    ],
  };
}
