import { performance } from "node:perf_hooks";

import type {
  PersonalMcpPlugin,
  PluginHealth,
  PluginHealthState,
} from "./plugin.js";

const HEALTH_STATES = new Set<PluginHealthState>([
  "unknown",
  "unconfigured",
  "healthy",
  "degraded",
  "unhealthy",
]);
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export interface PluginHealthResolutionOptions {
  readonly onFailure?: (error: unknown) => void;
  readonly timeoutMs?: number;
}

/** Runs an optional Plugin check inside the Runtime's failure-isolation boundary. */
export async function resolvePluginHealth(
  plugin: PersonalMcpPlugin,
  options: PluginHealthResolutionOptions = {},
): Promise<PluginHealth> {
  const startedAt = performance.now();
  let check: PersonalMcpPlugin["checkHealth"];
  try {
    check = plugin.checkHealth;
  } catch (error) {
    reportFailure(options.onFailure, error);
    return failedHealth(startedAt);
  }
  if (check === undefined) return { state: "unknown" };

  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const controller = new AbortController();
  try {
    const result = await withTimeout(
      Promise.resolve(check.call(plugin, controller.signal)),
      timeoutMs,
      controller,
      plugin.id,
    );
    if (!isPluginHealth(result)) {
      throw new Error(`Plugin ${plugin.id} returned an invalid health result`);
    }
    return normalizedHealth(result, startedAt);
  } catch (error) {
    reportFailure(options.onFailure, error);
    return failedHealth(startedAt);
  }
}

function isPluginHealth(value: unknown): value is PluginHealth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const health = value as Partial<PluginHealth>;
  return HEALTH_STATES.has(health.state as PluginHealthState)
    && (health.message === undefined || typeof health.message === "string")
    && (health.latencyMs === undefined
      || (typeof health.latencyMs === "number" && Number.isFinite(health.latencyMs) && health.latencyMs >= 0))
    && (health.checkedAt === undefined || typeof health.checkedAt === "string");
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function normalizedHealth(result: PluginHealth, startedAt: number): PluginHealth {
  return {
    state: result.state,
    ...(result.message === undefined ? {} : { message: result.message }),
    latencyMs: result.latencyMs ?? elapsedMilliseconds(startedAt),
    checkedAt: result.checkedAt ?? new Date().toISOString(),
  };
}

function failedHealth(startedAt: number): PluginHealth {
  return {
    state: "unhealthy",
    message: "Health check failed",
    latencyMs: elapsedMilliseconds(startedAt),
    checkedAt: new Date().toISOString(),
  };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  pluginId: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Plugin health timeout must be a positive finite number");
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Plugin ${pluginId} health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reportFailure(
  onFailure: PluginHealthResolutionOptions["onFailure"],
  error: unknown,
): void {
  try {
    onFailure?.(error);
  } catch {
    // Reporting is observational and cannot escape the health isolation boundary.
  }
}
