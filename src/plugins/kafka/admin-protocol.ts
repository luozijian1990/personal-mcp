import { createRequire } from "node:module";
import { z } from "zod/v4";
import { Reader, QueryError, type ProtocolRequest } from "./protocol.js";
const require = createRequire(import.meta.url);
const Encoder = require("kafkajs/src/protocol/encoder.js") as new () => { writeBuffer(b: Buffer): unknown };
const integer = z.number().int();
const long = z.string().regex(/^-?\d+$/);
export const logDirsSchema = z.object({ errorCode: integer, directories: z.array(z.object({ errorCode: integer, path: z.string(), totalBytes: long.nullable(), usableBytes: long.nullable(), replicas: z.array(z.object({ topic: z.string(), partition: integer, sizeBytes: long, offsetLag: long, isFuture: z.boolean() })) })) });
export const quotasSchema = z.object({ errorCode: integer, entries: z.array(z.object({ entity: z.array(z.object({ type: z.string(), name: z.string().nullable() })), values: z.array(z.object({ key: z.string(), value: z.number().finite() })) })) });
export const reassignmentsSchema = z.object({ errorCode: integer, topics: z.array(z.object({ topic: z.string(), partitions: z.array(z.object({ partition: integer, replicas: z.array(integer), addingReplicas: z.array(integer), removingReplicas: z.array(integer) })) })) });
const replica = z.object({ replicaId: integer, logEndOffset: long, lastFetchTimestamp: long.nullable(), lastCaughtUpTimestamp: long.nullable() });
export const quorumSchema = z.object({ errorCode: integer, topics: z.array(z.object({ topic: z.string(), partitions: z.array(z.object({ partition: integer, errorCode: integer, leaderId: integer, leaderEpoch: integer, highWatermark: long, voters: z.array(replica), observers: z.array(replica) })) })) });
export type TopicPartitions = { topic: string; partitions: number[] };
export type QuotaComponent = { entityType: "user" | "client-id"; matchType: 0 | 1 | 2; match: string | null };
export const ADMIN_APIS = { DescribeLogDirs: 35, DescribeClientQuotas: 48, ListPartitionReassignments: 46, DescribeQuorum: 55 } as const;
export type AdminApi = keyof typeof ADMIN_APIS;
class Writer {
  chunks: Buffer[] = [];
  byte(n: number) { this.chunks.push(Buffer.from([n])); return this; }
  int(n: number) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.chunks.push(b); return this; }
  uv(n: number) { do { const v = n % 128; n = Math.floor(n / 128); this.byte(v + (n ? 128 : 0)); } while (n); return this; }
  string(s: string | null, compact: boolean) { const b = s === null ? null : Buffer.from(s); if (compact) this.uv(b ? b.length + 1 : 0); else { const n = Buffer.alloc(2); n.writeInt16BE(b ? b.length : -1); this.chunks.push(n); } if (b) this.chunks.push(b); return this; }
  array<T>(items: T[] | null, compact: boolean, fn: (v: T) => void) { compact ? this.uv(items ? items.length + 1 : 0) : this.int(items ? items.length : -1); items?.forEach(fn); return this; }
  buffer() { return Buffer.concat(this.chunks); }
}
function readArray<T>(r: Reader, flexible: boolean, fn: () => T, nullable = false): T[] {
  const n = flexible ? r.uvar() - 1 : r.i32(); if (n === -1 && nullable) return [];
  const count = r.count(n);
  const items: T[] = [];
  for (let i = 0; i < count; i++) items.push(fn());
  return items;
}
const readString = (r: Reader, flex: boolean, nullable = false): string | null => {
  if (!flex) return nullable ? r.nullableString() : r.string();
  const n = r.uvar() - 1; if (nullable && n === -1) return null; return r.bytes(n).toString("utf8");
};
const i64 = (r: Reader) => r.bytes(8).readBigInt64BE().toString();
const tags = (r: Reader, flex: boolean) => { if (flex) r.tags(); };
function select(versions: Record<number, { minVersion: number; maxVersion: number }>, key: number, supported: number[]): number {
  const range = versions[key]; const found = range && supported.find(v => v >= range.minVersion && v <= range.maxVersion);
  if (found === undefined) throw new QueryError("UNSUPPORTED_VERSION", `No supported read-only protocol version for Kafka API ${key}`);
  return found;
}
/** Fixed read requests only. Flexible header tags precede the body because KafkaJS builds header v1. */
export function adminRequest(api: AdminApi, versions: Record<number, { minVersion: number; maxVersion: number }>, args: object): ProtocolRequest {
  const key = ADMIN_APIS[api];
  const version = select(versions, key, api === "DescribeLogDirs" ? [4, 3, 2, 1] : api === "ListPartitionReassignments" ? [0] : [1, 0]);
  const flex = api === "DescribeLogDirs" ? version >= 2 : api === "DescribeClientQuotas" ? version >= 1 : true;
  const w = new Writer(); if (flex) w.byte(0);
  if (api === "DescribeLogDirs" || api === "ListPartitionReassignments") {
    const a = args as { topics?: TopicPartitions[] | null; timeout?: number };
    if (api === "ListPartitionReassignments") w.int(a.timeout ?? 10000);
    w.array(a.topics ?? null, flex, t => { w.string(t.topic, flex).array(t.partitions, flex, p => { w.int(p); }); if (flex) w.byte(0); });
  } else if (api === "DescribeClientQuotas") {
    const a = args as { components: QuotaComponent[]; strict: boolean };
    w.array(a.components, flex, c => { w.string(c.entityType, flex).byte(c.matchType).string(c.match, flex); if (flex) w.byte(0); }).byte(Number(a.strict));
  } else {
    w.array([{ topic: "__cluster_metadata", partitions: [0] }], true, t => {
      w.string(t.topic, true).array(t.partitions, true, p => { w.int(p).byte(0); }).byte(0);
    });
  }
  if (flex) w.byte(0);
  return { request: { apiKey: key, apiVersion: version, apiName: api, encode: async () => new Encoder().writeBuffer(w.buffer()) }, response: {
    parse: async data => data,
    decode: async buffer => {
      const r = new Reader(buffer); tags(r, flex);
      let result: unknown;
      if (api === "DescribeLogDirs") {
        r.i32(); const errorCode = version >= 3 ? r.i16() : 0;
        const directories = readArray(r, flex, () => {
          const errorCode = r.i16(); const path = readString(r, flex)!;
          const replicas = readArray(r, flex, () => {
            const topic = readString(r, flex)!;
            const partitions = readArray(r, flex, () => { const partition = r.i32(); const sizeBytes = i64(r); const offsetLag = i64(r); const isFuture = r.bytes(1)[0] !== 0; tags(r, flex); return { topic, partition, sizeBytes, offsetLag, isFuture }; });
            tags(r, flex); return partitions;
          }).flat();
          const totalBytes = version >= 4 ? i64(r) : null; const usableBytes = version >= 4 ? i64(r) : null; tags(r, flex);
          return { errorCode, path, replicas, totalBytes, usableBytes };
        }); result = { errorCode, directories };
      } else if (api === "DescribeClientQuotas") {
        r.i32(); const errorCode = r.i16(); readString(r, flex, true);
        const entries = readArray(r, flex, () => {
          const entity = readArray(r, flex, () => { const type = readString(r, flex)!; const name = readString(r, flex, true); tags(r, flex); return { type, name }; });
          const values = readArray(r, flex, () => { const key = readString(r, flex)!; const value = r.bytes(8).readDoubleBE(); if (!Number.isFinite(value)) throw new QueryError("INVALID_RESPONSE", "Non-finite Kafka quota value"); tags(r, flex); return { key, value }; });
          tags(r, flex); return { entity, values };
        }, true); result = { errorCode, entries };
      } else if (api === "ListPartitionReassignments") {
        r.i32(); const errorCode = r.i16(); readString(r, true, true);
        const topics = readArray(r, true, () => {
          const topic = r.compact(); const partitions = readArray(r, true, () => {
            const partition = r.i32(); const replicas = readArray(r, true, () => r.i32()); const addingReplicas = readArray(r, true, () => r.i32()); const removingReplicas = readArray(r, true, () => r.i32()); r.tags(); return { partition, replicas, addingReplicas, removingReplicas };
          }); r.tags(); return { topic, partitions };
        }); result = { errorCode, topics };
      } else {
        const errorCode = r.i16();
        const readReplica = () => { const replicaId = r.i32(); const logEndOffset = i64(r); const lastFetchTimestamp = version >= 1 ? i64(r) : null; const lastCaughtUpTimestamp = version >= 1 ? i64(r) : null; r.tags(); return { replicaId, logEndOffset, lastFetchTimestamp, lastCaughtUpTimestamp }; };
        const topics = readArray(r, true, () => { const topic = r.compact(); const partitions = readArray(r, true, () => {
          const partition = r.i32(); const errorCode = r.i16(); const leaderId = r.i32(); const leaderEpoch = r.i32(); const highWatermark = i64(r); const voters = readArray(r, true, readReplica); const observers = readArray(r, true, readReplica); r.tags(); return { partition, errorCode, leaderId, leaderEpoch, highWatermark, voters, observers };
        }); r.tags(); return { topic, partitions }; }); result = { errorCode, topics };
      }
      tags(r, flex); r.done(); return result;
    },
  } };
}
