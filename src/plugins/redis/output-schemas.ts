import { z } from "zod/v4";
const encoded = z.object({ encoding: z.enum(["utf8", "base64"]), value: z.string(), bytes: z.number().int(), returnedBytes: z.number().int(), truncated: z.boolean() });
const scanData = z.object({ type: z.enum(["keys", "hash", "set"]), items: z.array(z.union([encoded, z.object({ field: encoded, value: encoded })])), scanRounds: z.number().int() });
const envelope = <T extends z.ZodType>(data: T) => z.object({
  db: z.number().int(), data,
  complete: z.boolean().describe("Requested traversal/window complete; per-value truncated flags separately describe previews. Diagnostics false means missing sections."),
  nextCursor: z.string().nullable().describe("Opaque scan continuation, valid for five minutes on this plugin instance; null when no continuation"), notes: z.array(z.string()),
});
export const scanOutput = envelope(scanData);
export const readOutput = envelope(z.union([
  z.object({ type: z.literal("none"), exists: z.literal(false) }),
  z.object({ type: z.literal("string"), exists: z.literal(true), totalBytes: z.number().int(), offset: z.number().int(), value: encoded, nextOffset: z.number().int().nullable() }),
  scanData,
  z.object({ type: z.enum(["list", "zset"]), total: z.number().int(), offset: z.number().int(), items: z.array(z.union([encoded, z.object({ member: encoded, score: z.string() })])), nextOffset: z.number().int().nullable() }),
]));
export const inspectOutput = envelope(z.object({ type: z.string(), ttlMs: z.number().int(), exists: z.boolean(), memory: z.union([
  z.object({ status: z.literal("available"), bytes: z.number().int().nullable(), samples: z.number().int() }),
  z.object({ status: z.literal("unavailable"), error: z.string() }),
]) }));
export const diagnoseOutput = envelope(z.object({ sections: z.record(z.string(), z.union([
  z.object({ status: z.literal("available"), fields: z.record(z.string(), z.string()) }),
  z.object({ status: z.literal("unavailable"), error: z.string() }),
])) }));
export const slowlogOutput = envelope(z.object({ entries: z.array(z.object({ id: z.number().int(), unixSeconds: z.number().int(), durationUs: z.number().int(), command: encoded, arguments: z.array(encoded).nullable() })), argumentsIncluded: z.boolean(), limit: z.number().int(), responseTruncated: z.boolean() }));
