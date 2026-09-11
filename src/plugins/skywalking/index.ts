import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { PersonalMcpPlugin, PersonalMcpPluginMetadata } from "../../core/plugin.js";
import { toolStructuredResult } from "../../core/tool-result.js";
import { SKYWALKING_CONFIG_FIELDS, type SkyWalkingPluginConfig } from "./config.js";
import { skywalkingGraphql } from "./client.js";
import { buildDuration, type TimeInfo } from "./duration.js";
import { getTraceDetail, traceDetailInputSchema, traceDetailOutputSchema } from "./trace-detail.js";

export const SKYWALKING_PLUGIN_METADATA: PersonalMcpPluginMetadata = {
  id: "skywalking", displayName: "SkyWalking APM",
  summary: "查询 SkyWalking OAP 服务、实例、Trace 和服务拓扑。",
  category: { id: "observability", name: "可观测性", description: "查询应用性能与调用链。" },
};
const range = z.object({
  start: z.string().default("now-30m").describe("now、now-30m 或带时区的 ISO 8601 时间"),
  end: z.string().default("now").describe("now 或带时区的 ISO 8601 时间"),
});
const entity = z.object({ id: z.string(), name: z.string() });
const trace = z.object({ segmentId: z.string(), endpointNames: z.array(z.string()), duration: z.number(), start: z.string(), isError: z.boolean(), traceIds: z.array(z.string()) });
const topology = z.object({ nodes: z.array(entity), calls: z.array(z.object({ source: z.string(), target: z.string() })) });
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function createSkyWalkingPlugin(config: SkyWalkingPluginConfig): PersonalMcpPlugin {
  return {
    ...SKYWALKING_PLUGIN_METADATA,
    tools: [
      { name: "skywalking_list_services", title: "列出服务" },
      { name: "skywalking_list_instances", title: "列出实例" },
      { name: "skywalking_query_traces", title: "查询 Trace" },
      { name: "skywalking_get_trace", title: "查询 Trace Span 详情" },
      { name: "skywalking_query_service_topology", title: "查询服务拓扑" },
    ].map(tool => ({ ...tool, risk: "read-only" as const, logging: { input: "metadata" as const, output: "metadata" as const } })),
    config: { fields: SKYWALKING_CONFIG_FIELDS },
    checkHealth: async (signal) => {
      if (!config.url) return { state: "unconfigured", message: "SkyWalking URL is not configured" };
      try {
        const result = await skywalkingGraphql<{ version: string }>(config, "query { version }", {}, signal);
        if (!result.version) throw new Error("SkyWalking OAP returned no version");
        return { state: "healthy", message: `SkyWalking OAP GraphQL is reachable (${result.version})` };
      } catch (error) {
        return { state: "unhealthy", message: error instanceof Error ? error.message : String(error) };
      }
    },
    createServer: () => createServer(config),
  };
}

function createServer(config: SkyWalkingPluginConfig): McpServer {
  const server = new McpServer({ name: "skywalking-mcp-server", version: "0.1.0" });
  const query = async <T extends object>(document: string, variables: Record<string, unknown> = {}) => skywalkingGraphql<T>(config, document, variables);
  const duration = async (args: { start: string; end: string }) => {
    const result = await query<{ getTimeInfo: TimeInfo }>("query { getTimeInfo { timezone currentTimestamp } }");
    return buildDuration(args.start, args.end, result.getTimeInfo);
  };
  server.registerTool("skywalking_list_services", {
    description: "按 layer 列出服务，默认 GENERAL。返回服务 ID 和名称。", annotations,
    inputSchema: z.object({ layer: z.string().default("GENERAL") }),
    outputSchema: z.object({ listServices: z.array(entity) }),
  }, async ({ layer }) => toolStructuredResult(await query("query($layer:String!){ listServices(layer:$layer) { id name } }", { layer })));

  server.registerTool("skywalking_list_instances", {
    description: "查询指定服务在时间范围内的实例。", annotations,
    inputSchema: z.object({ serviceId: z.string().min(1), ...range.shape }),
    outputSchema: z.object({ listInstances: z.array(entity) }),
  }, async args => toolStructuredResult(await query("query($id:ID!,$duration:Duration!){ listInstances(serviceId:$id,duration:$duration) { id name } }", { id: args.serviceId, duration: await duration(args) })));

  server.registerTool("skywalking_query_traces", {
    description: "分页查询 Trace 摘要；full 返回全部 BasicTrace 字段（Span 详情使用 skywalking_get_trace），errors_only 只查错误。endpointName 为精确名称且须提供 serviceId。", annotations,
    inputSchema: z.object({
      serviceId: z.string().min(1).optional(), endpointName: z.string().min(1).optional(), endpointId: z.string().min(1).optional(),
      ...range.shape, view: z.enum(["summary", "full", "errors_only"]).default("summary"),
      pageNum: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(20),
    }),
    outputSchema: z.object({ queryBasicTraces: z.object({ traces: z.array(trace.partial().required({ traceIds: true, duration: true, isError: true })) }) }),
  }, async args => {
    let endpointId = args.endpointId;
    if (args.endpointName) {
      if (!args.serviceId || endpointId) throw new Error("endpointName requires serviceId and cannot be combined with endpointId");
      const found = await query<{ findEndpoint: Array<{ id: string; name: string }> }>("query($serviceId:ID!,$keyword:String!){ findEndpoint(serviceId:$serviceId,keyword:$keyword,limit:100) { id name } }", { serviceId: args.serviceId, keyword: args.endpointName });
      const matches = found.findEndpoint.filter(item => item.name === args.endpointName);
      if (matches.length !== 1) throw new Error("Endpoint name did not resolve uniquely; supply endpointId");
      endpointId = matches[0]!.id;
    }
    const condition = {
      ...(args.serviceId ? { serviceId: args.serviceId } : {}), ...(endpointId ? { endpointId } : {}),
      queryDuration: await duration(args), traceState: args.view === "errors_only" ? "ERROR" : "ALL",
      queryOrder: "BY_START_TIME", paging: { pageNum: args.pageNum, pageSize: args.pageSize },
    };
    const fields = args.view === "full" ? "segmentId endpointNames duration start isError traceIds" : "traceIds duration isError";
    return toolStructuredResult(await query(`query($condition:TraceQueryCondition!){ queryBasicTraces(condition:$condition) { traces { ${fields} } } }`, { condition }));
  });

  server.registerTool("skywalking_get_trace", {
    description: "按 Trace ID 查询 Span 详情，包含父子关系、跨 Segment 引用、服务/实例、端点、毫秒时间与耗时、标签和异常日志/堆栈。支持服务及错误过滤，按开始时间排序后分页；保留原始日志内容。",
    annotations, inputSchema: traceDetailInputSchema, outputSchema: traceDetailOutputSchema,
  }, async args => toolStructuredResult(await getTraceDetail(config, args)));

  server.registerTool("skywalking_query_service_topology", {
    description: "查询指定服务的拓扑；省略 serviceIds 时返回全局服务拓扑。", annotations,
    inputSchema: z.object({ ...range.shape, serviceIds: z.array(z.string().min(1)).max(100).default([]) }),
    outputSchema: z.object({ getServicesTopology: topology }),
  }, async args => {
    const time = await duration(args);
    return toolStructuredResult(args.serviceIds.length
      ? await query("query($serviceIds:[ID!]!,$duration:Duration!){ getServicesTopology(serviceIds:$serviceIds,duration:$duration) { nodes { id name } calls { source target } } }", { serviceIds: args.serviceIds, duration: time })
      : await query("query($duration:Duration!){ getServicesTopology: getGlobalTopology(duration:$duration) { nodes { id name } calls { source target } } }", { duration: time }));
  });
  return server;
}
