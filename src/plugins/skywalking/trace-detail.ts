import { z } from "zod/v4";
import { skywalkingGraphql } from "./client.js";
import type { SkyWalkingPluginConfig } from "./config.js";

const keyValue = z.object({ key: z.string(), value: z.string().nullable() });
const spanSchema = z.object({
  traceId: z.string(), segmentId: z.string(), spanId: z.number().int(), parentSpanId: z.number().int(),
  refs: z.array(z.object({ traceId: z.string(), parentSegmentId: z.string(), parentSpanId: z.number().int(), type: z.string() })),
  serviceCode: z.string(), serviceInstanceName: z.string(),
  startTime: z.number().int(), endTime: z.number().int(),
  endpointName: z.string().nullable(), type: z.string(), peer: z.string().nullable(),
  component: z.string().nullable(), isError: z.boolean().nullable(), layer: z.string().nullable(),
  tags: z.array(keyValue), logs: z.array(z.object({ time: z.number().int(), data: z.array(keyValue) })),
});
export const traceDetailInputSchema = z.object({
  traceId: z.string().trim().min(1).max(512).describe("从 skywalking_query_traces 返回的 traceIds 中取一个 ID"),
  serviceName: z.string().min(1).optional().describe("精确匹配 serviceCode，例如 [test-tms]tmsexpresscharging；省略查询整条链路"),
  errorsOnly: z.boolean().default(false).describe("仅返回 isError=true 的 Span；过滤后可能缺少父节点"),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export const traceDetailOutputSchema = z.object({
  traceId: z.string(), totalSpans: z.number().int(), matchedSpans: z.number().int(),
  offset: z.number().int(), hasMore: z.boolean(), nextOffset: z.number().int().nullable(),
  spans: z.array(spanSchema.extend({ durationMs: z.number() })),
});

export async function getTraceDetail(config: SkyWalkingPluginConfig, args: z.infer<typeof traceDetailInputSchema>) {
  const response = await skywalkingGraphql<unknown>(config, `query($traceId:ID!) {
    queryTrace(traceId:$traceId) { spans {
      traceId segmentId spanId parentSpanId
      refs { traceId parentSegmentId parentSpanId type }
      serviceCode serviceInstanceName startTime endTime endpointName type peer component isError layer
      tags { key value } logs { time data { key value } }
    } }
  }`, { traceId: args.traceId });
  const { queryTrace } = z.object({ queryTrace: z.object({ spans: z.array(spanSchema) }).nullable() }).parse(response);
  const all = queryTrace?.spans ?? [];
  const matched = all.filter(span => (!args.serviceName || span.serviceCode === args.serviceName) && (!args.errorsOnly || span.isError === true));
  matched.sort((a, b) => a.startTime - b.startTime || a.segmentId.localeCompare(b.segmentId) || a.spanId - b.spanId);
  const spans = matched.slice(args.offset, args.offset + args.limit).map(span => ({ ...span, durationMs: span.endTime - span.startTime }));
  const hasMore = args.offset + spans.length < matched.length;
  return {
    traceId: args.traceId, totalSpans: all.length, matchedSpans: matched.length,
    offset: args.offset, hasMore, nextOffset: hasMore ? args.offset + spans.length : null, spans,
  };
}
