import { performance } from "node:perf_hooks";

import type { PrometheusPluginConfig } from "./config.js";

const API_PATH = "/api/v1";

export interface PrometheusQueryResult {
  readonly query: string;
  readonly status: "success" | "error";
  readonly data: unknown | null;
  readonly errorType: string | null;
  readonly error: string | null;
  readonly durationMs: number;
}

export interface PrometheusQueryInput {
  readonly query: string;
  readonly time?: string | number;
}

export interface PrometheusRangeQueryInput {
  readonly query: string;
  readonly start: string | number;
  readonly end: string | number;
  readonly step: string | number;
}

export async function queryPrometheus(
  config: PrometheusPluginConfig,
  input: PrometheusQueryInput,
): Promise<PrometheusQueryResult> {
  const params = new URLSearchParams({ query: input.query });
  if (input.time !== undefined) params.set("time", String(input.time));
  return requestPrometheus(config, `${API_PATH}/query?${params.toString()}`, input.query);
}

export async function queryPrometheusRange(
  config: PrometheusPluginConfig,
  input: PrometheusRangeQueryInput,
): Promise<PrometheusQueryResult> {
  const params = new URLSearchParams({
    query: input.query,
    start: String(input.start),
    end: String(input.end),
    step: String(input.step),
  });
  return requestPrometheus(config, `${API_PATH}/query_range?${params.toString()}`, input.query);
}

async function requestPrometheus(
  config: PrometheusPluginConfig,
  requestPath: string,
  query: string,
): Promise<PrometheusQueryResult> {
  const startedAt = performance.now();
  if (config.url.trim().length === 0) {
    return makeError(query, "configuration", "PROMETHEUS_MCP_URL is not configured", startedAt);
  }
  if (!Number.isSafeInteger(config.queryTimeoutSeconds)
    || config.queryTimeoutSeconds < 1
    || config.queryTimeoutSeconds > 300) {
    return makeError(
      query,
      "configuration",
      "PROMETHEUS_MCP_QUERY_TIMEOUT must be between 1 and 300 seconds",
      startedAt,
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(`${requestPath.slice(1)}`, ensureTrailingSlash(config.url));
  } catch (error) {
    return makeError(query, "configuration", `Invalid Prometheus URL: ${errorMessage(error)}`, startedAt);
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1, config.queryTimeoutSeconds) * 1_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const body = await parseJson(response);
    const durationMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      return {
        query,
        status: "error",
        data: bodyData(body),
        errorType: bodyErrorType(body) ?? `http_${response.status}`,
        error: bodyError(body) ?? `Prometheus returned HTTP ${response.status}`,
        durationMs,
      };
    }
    if (bodyStatus(body) !== "success") {
      return {
        query,
        status: "error",
        data: bodyData(body),
        errorType: bodyErrorType(body),
        error: bodyError(body) ?? "Prometheus returned an unsuccessful response",
        durationMs,
      };
    }
    return {
      query,
      status: "success",
      data: bodyData(body),
      errorType: null,
      error: null,
      durationMs,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return makeError(
      query,
      timedOut ? "timeout" : "network",
      timedOut
        ? `Prometheus query timed out after ${config.queryTimeoutSeconds} seconds`
        : `Unable to query Prometheus: ${errorMessage(error)}`,
      startedAt,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function makeError(
  query: string,
  errorType: string,
  error: string,
  startedAt: number,
): PrometheusQueryResult {
  return {
    query,
    status: "error",
    data: null,
    errorType,
    error,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function bodyStatus(body: unknown): string | undefined {
  return isRecord(body) && typeof body.status === "string" ? body.status : undefined;
}

function bodyData(body: unknown): unknown | null {
  return isRecord(body) && "data" in body ? body.data ?? null : null;
}

function bodyErrorType(body: unknown): string | null {
  return isRecord(body) && typeof body.errorType === "string" ? body.errorType : null;
}

function bodyError(body: unknown): string | null {
  return isRecord(body) && typeof body.error === "string" ? body.error : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
