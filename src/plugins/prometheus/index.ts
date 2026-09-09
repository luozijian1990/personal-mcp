import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import type { PersonalMcpPlugin, PersonalMcpPluginMetadata } from "../../core/plugin.js";
import {
  PROMETHEUS_CONFIG_FIELDS,
  type PrometheusPluginConfig,
  loadPrometheusPluginConfig,
} from "./config.js";
import {
  queryPrometheus,
  queryPrometheusRange,
  type PrometheusQueryResult,
} from "./client.js";

const querySchema = z
  .string()
  .trim()
  .min(1)
  .max(16_384)
  .describe("要执行的 PromQL 表达式，例如 up 或 rate(http_requests_total[5m])");

const timeSchema = z
  .union([z.string().trim().min(1), z.number().finite()])
  .optional()
  .describe("可选查询时间，使用 Unix 秒数或 Prometheus 接受的 RFC3339 时间");

const resultSchema = z.object({
  query: z.string(),
  status: z.enum(["success", "error"]),
  data: z.unknown().nullable(),
  errorType: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
});

export interface CreatePrometheusPluginOptions {
  readonly config?: PrometheusPluginConfig;
}

export const PROMETHEUS_PLUGIN_METADATA: PersonalMcpPluginMetadata = {
  id: "prometheus",
  displayName: "Prometheus Metrics",
  summary: "使用 PromQL 查询 Prometheus 指标，支持即时查询和区间查询。",
  category: {
    id: "observability",
    name: "可观测性",
    description: "查询指标、监控和运行状态数据。",
  },
};

export function createPrometheusPlugin(
  options: CreatePrometheusPluginOptions = {},
): PersonalMcpPlugin {
  const config = options.config ?? loadPrometheusPluginConfig();
  return {
    ...PROMETHEUS_PLUGIN_METADATA,
    tools: [
      { name: "prometheus_query", title: "即时查询", risk: "read-only", logging: { input: "full", output: "metadata" } },
      { name: "prometheus_query_range", title: "区间查询", risk: "read-only", logging: { input: "full", output: "metadata" } },
    ],
    config: { fields: PROMETHEUS_CONFIG_FIELDS },
    createServer: () => createPrometheusServer(config),
  };
}

function createPrometheusServer(config: PrometheusPluginConfig): McpServer {
  const server = new McpServer({ name: "prometheus-mcp-server", version: "0.1.0" });

  server.registerTool(
    "prometheus_query",
    {
      title: "Query Prometheus instantly",
      description:
        "Execute one read-only PromQL instant query against the configured Prometheus server. The configured query timeout applies to the complete HTTP request. Returns Prometheus' native resultType and result in data.",
      inputSchema: z.object({
        query: querySchema,
        time: timeSchema,
      }),
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, time }) => toolResult(await queryPrometheus(
      config,
      time === undefined ? { query } : { query, time },
    )),
  );

  server.registerTool(
    "prometheus_query_range",
    {
      title: "Query Prometheus over a range",
      description:
        "Execute one read-only PromQL range query against the configured Prometheus server. Start, end, and step use Unix seconds or Prometheus-compatible duration/time strings. The configured query timeout applies to the complete HTTP request.",
      inputSchema: z.object({
        query: querySchema,
        start: z.union([z.string().trim().min(1), z.number().finite()]).describe(
          "查询起始时间，Unix 秒数或 RFC3339 时间",
        ),
        end: z.union([z.string().trim().min(1), z.number().finite()]).describe(
          "查询结束时间，Unix 秒数或 RFC3339 时间",
        ),
        step: z.union([z.string().trim().min(1), z.number().finite()]).describe(
          "采样步长，例如 15s、5m 或秒数",
        ),
      }),
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, start, end, step }) => toolResult(
      await queryPrometheusRange(config, { query, start, end, step }),
    ),
  );

  return server;
}

function toolResult(result: PrometheusQueryResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: result.status === "error",
  };
}
