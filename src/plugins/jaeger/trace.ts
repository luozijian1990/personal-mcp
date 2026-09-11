import { z } from "zod/v4";

const list = <T extends z.ZodType>(item: T) => z.array(item).nullable();
export const tagSchema = z.object({ key: z.string(), type: z.string(), value: z.json() });
export const processSchema = z.object({ serviceName: z.string(), tags: list(tagSchema) });
export const spanSchema = z.object({
  traceID: z.string(), spanID: z.string(), operationName: z.string(), processID: z.string(),
  startTime: z.number().int().nonnegative().safe(), duration: z.number().int().nonnegative().safe(),
  references: list(z.object({ refType: z.string(), traceID: z.string(), spanID: z.string() })),
  tags: list(tagSchema), logs: list(z.object({ timestamp: z.number().int().nonnegative().safe(), fields: list(tagSchema) })),
  warnings: list(z.string()).optional(),
});
export const traceSchema = z.object({ traceID: z.string(), spans: z.array(spanSchema), processes: z.record(z.string(), processSchema), warnings: list(z.string()).optional() });
export const tracesSchema = list(traceSchema).transform(value => value ?? []);
export type Trace = z.infer<typeof traceSchema>;
export type Span = z.infer<typeof spanSchema>;
export function errorEvidence(span: Span): string[] {
  const reasons = new Set<string>();
  for (const { key, value } of span.tags ?? []) {
    if (key === "error" && (value === true || value === "true")) reasons.add("error=true");
    if (key === "otel.status_code" && (String(value).toUpperCase() === "ERROR" || value === 2)) reasons.add("otel.status_code=ERROR");
    if (["http.status_code", "http.response.status_code"].includes(key) && Number(value) >= 500 && Number(value) < 600) reasons.add(`${key}=${value}`);
  }
  if ((span.logs ?? []).some(log => (log.fields ?? []).some(field => field.key.startsWith("exception.") || (field.key === "event" && field.value === "exception")))) reasons.add("exception event");
  return [...reasons];
}
export const normalizedSpanSchema = spanSchema.extend({ serviceName: z.string().nullable(), process: processSchema.nullable(), startTimeMs: z.number(), durationMs: z.number(), isError: z.boolean(), errorEvidence: z.array(z.string()) });
export function normalizeSpan(span: Span, trace: Trace) {
  const evidence = errorEvidence(span);
  const process = trace.processes[span.processID] ?? null;
  return { ...span, serviceName: process?.serviceName ?? null, process, startTimeMs: span.startTime / 1000, durationMs: span.duration / 1000, isError: evidence.length > 0, errorEvidence: evidence };
}
export const summarySchema = z.object({ traceId: z.string(), startTimeMs: z.number().nullable(), durationMs: z.number().nullable(), spanCount: z.number().int(), services: z.array(z.string()), isError: z.boolean(), errorSpanCount: z.number().int(), warnings: z.array(z.string()) });
export function summarize(trace: Trace) {
  let start = Infinity, end = -Infinity, errors = 0;
  for (const span of trace.spans) { start = Math.min(start, span.startTime); end = Math.max(end, span.startTime + span.duration); if (errorEvidence(span).length) errors++; }
  return { traceId: trace.traceID, startTimeMs: trace.spans.length ? start / 1000 : null, durationMs: trace.spans.length ? (end - start) / 1000 : null, spanCount: trace.spans.length, services: [...new Set(Object.values(trace.processes).map(p => p.serviceName))].sort(), isError: errors > 0, errorSpanCount: errors, warnings: trace.warnings ?? [] };
}
