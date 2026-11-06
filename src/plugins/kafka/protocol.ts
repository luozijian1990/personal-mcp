// KafkaJS 2.2.4 internals are deliberately confined to this file and client.ts.
// Public Admin methods discard evidence and fetchOffsets(resolveOffsets=true) writes offsets.
import { createRequire } from "node:module";
import { z } from "zod/v4";
const require = createRequire(import.meta.url);
export const errorFromCode: (code: number) => { type: string; retriable: boolean } = require("kafkajs/src/protocol/error.js").createErrorFromCode;

export class QueryError extends Error {
  constructor(public code: string, message: string, public retriable = false) { super(message); }
}
export function checkCode(code: number): void {
  if (code) { const e = errorFromCode(code); throw new QueryError(e.type, `Kafka returned ${e.type} (${code})`, e.retriable); }
}
export function safeError(error: unknown): { code: string; message: string; retriable: boolean } {
  if (error instanceof QueryError) return { code: error.code, message: error.message, retriable: error.retriable };
  if (error instanceof z.ZodError) return { code: "INVALID_RESPONSE", message: "Kafka response did not match the expected protocol shape", retriable: false };
  const e = error as { type?: unknown; name?: unknown; code?: unknown; retriable?: unknown; cause?: unknown } | null;
  const identifier = e?.type ?? e?.code ?? e?.name;
  const code = typeof identifier === "string" && /^[A-Za-z0-9_]{1,80}$/.test(identifier) ? identifier : "BACKEND_ERROR";
  // Do not expose backend messages (SASL, hostnames and configuration may contain secrets).
  return { code, message: `Kafka query failed (${code}); check connectivity, TLS, ACLs and supported protocol versions`, retriable: e?.retriable === true };
}
export const brokerSchema = z.object({ nodeId: z.number().int(), host: z.string(), port: z.number().int(), rack: z.string().nullable().optional() });
const partitionSchema = z.object({ partitionErrorCode: z.number().int(), partitionId: z.number().int(), leader: z.number().int(), replicas: z.array(z.number().int()), isr: z.array(z.number().int()), offlineReplicas: z.array(z.number().int()).optional() });
export const metadataSchema = z.object({ brokers: z.array(brokerSchema), clusterId: z.string().nullable(), controllerId: z.number().int(), topicMetadata: z.array(z.object({ topicErrorCode: z.number().int(), topic: z.string(), isInternal: z.boolean(), partitionMetadata: z.array(partitionSchema) })) });
export type Metadata = z.infer<typeof metadataSchema>;
export type BrokerAddress = z.infer<typeof brokerSchema>;
export const listedGroupSchema = z.object({ groupId: z.string(), protocolType: z.string(), groupState: z.string().optional(), groupType: z.string().optional() });
export const groupsSchema = z.object({ errorCode: z.number().int(), groups: z.array(listedGroupSchema) });
export const coordinatorSchema = z.object({ errorCode: z.number().int(), coordinator: brokerSchema });
export const groupSchema = z.object({ groups: z.array(z.object({ errorCode: z.number().int(), groupId: z.string(), state: z.string(), protocolType: z.string(), protocol: z.string(), members: z.array(z.object({ memberId: z.string(), groupInstanceId: z.string().nullable().optional(), clientId: z.string(), clientHost: z.string(), memberMetadata: z.instanceof(Buffer), memberAssignment: z.instanceof(Buffer) })) })) });
export type RawGroup = z.infer<typeof groupSchema>["groups"][number];
export const offsetsSchema = z.object({ errorCode: z.number().int().optional(), responses: z.array(z.object({ topic: z.string(), partitions: z.array(z.object({ partition: z.number().int(), offset: z.string().regex(/^-?\d+$/), errorCode: z.number().int() })) })) });
export type Offsets = z.infer<typeof offsetsSchema>;
export const configsSchema = z.object({ resources: z.array(z.object({ errorCode: z.number().int(), resourceName: z.string(), configEntries: z.array(z.object({ configName: z.string(), configValue: z.string().nullable(), configSource: z.number().int().optional(), isDefault: z.boolean().optional(), isSensitive: z.boolean(), readOnly: z.boolean() })) })) });

export interface ProtocolRequest {
  request: { apiKey: number; apiVersion: number; apiName: string; encode: () => Promise<unknown> };
  response: { decode: (buffer: Buffer) => Promise<unknown>; parse: (data: unknown) => Promise<unknown> };
}
interface ProtocolFactory { versions: string[]; protocol: (options: { version: number }) => (args: object) => ProtocolRequest }
export const READ_APIS = { Metadata: 3, ListOffsets: 2, OffsetFetch: 9, FindCoordinator: 10, DescribeGroups: 15, ListGroups: 16, DescribeConfigs: 32, DescribeLogDirs: 35, DescribeClientQuotas: 48, ListPartitionReassignments: 46, DescribeQuorum: 55 } as const;
export type ReadApi = keyof typeof READ_APIS;
export function assertReadApi(name: string): asserts name is ReadApi {
  if (!Object.hasOwn(READ_APIS, name)) throw new QueryError("READ_ONLY_VIOLATION", "Kafka operation is outside the read-only allowlist");
}
export const factories: Record<ReadApi, ProtocolFactory> = require("kafkajs/src/protocol/requests/index.js").requests;

// Bounded decoder for consumer assignments and the small ListGroups flexible extension.
// Unknown tagged fields are skipped using their exact byte size (not nullable bytes).
export class Reader {
  private offset = 0;
  constructor(private buffer: Buffer) {}
  bytes(n: number): Buffer { if (n < 0 || !Number.isSafeInteger(n) || this.offset + n > this.buffer.length) throw new QueryError("INVALID_RESPONSE", "Malformed Kafka binary payload"); const b = this.buffer.subarray(this.offset, this.offset + n); this.offset += n; return b; }
  i16() { return this.bytes(2).readInt16BE(); }
  i32() { return this.bytes(4).readInt32BE(); }
  uvar(): number { let n = 0; for (let i = 0; i < 5; i++) { const b = this.bytes(1)[0]!; n += (b & 127) * 2 ** (7 * i); if (!(b & 128)) return n; } throw new QueryError("INVALID_RESPONSE", "Malformed Kafka varint"); }
  string() { return this.bytes(this.i16()).toString("utf8"); }
  nullableString() { const n = this.i16(); return n === -1 ? null : this.bytes(n).toString("utf8"); }
  compact() { return this.bytes(this.uvar() - 1).toString("utf8"); }
  count(n: number) { if (n < 0 || n > this.buffer.length - this.offset) throw new QueryError("INVALID_RESPONSE", "Malformed Kafka array"); return n; }
  tags() { const n = this.count(this.uvar()); for (let i = 0; i < n; i++) { this.uvar(); this.bytes(this.uvar()); } }
  done() { if (this.offset !== this.buffer.length) throw new QueryError("INVALID_RESPONSE", "Unexpected trailing Kafka payload"); }
}
export function decodeAssignment(buffer: Buffer): { topic: string; partitions: number[] }[] {
  if (buffer.length === 0) return [];
  const r = new Reader(buffer); const version = r.i16();
  if (version < 0 || version > 3) throw new QueryError("UNSUPPORTED_ASSIGNMENT", "Only classic consumer assignment versions 0..3 are supported");
  const result = []; const n = r.count(r.i32());
  for (let i = 0; i < n; i++) { const topic = r.string(); const count = r.count(r.i32()); const partitions = []; for (let j = 0; j < count; j++) partitions.push(r.i32()); result.push({ topic, partitions }); }
  const userDataLength = r.i32(); if (userDataLength !== -1) r.bytes(userDataLength); r.done(); return result;
}
export function decodeSubscription(buffer: Buffer): string[] {
  if (buffer.length === 0) return [];
  const r = new Reader(buffer); const version = r.i16();
  if (version < 0 || version > 3) throw new QueryError("UNSUPPORTED_SUBSCRIPTION", "Unknown classic consumer subscription version");
  const n = r.count(r.i32()); const topics = []; for (let i = 0; i < n; i++) topics.push(r.string());
  return topics; // Later fields are owned partitions/generation/rack; no private user data is exposed.
}
export function flexibleListGroups(version: 4 | 5): ProtocolRequest {
  const Encoder = require("kafkajs/src/protocol/encoder.js") as new () => { writeBuffer(b: Buffer): unknown };
  // KafkaJS uses request-header v1. Prefix its body with v2 header tags, then compact empty filters and body tags.
  const body = Buffer.from(version === 5 ? [0, 1, 1, 0] : [0, 1, 0]);
  return {
    request: { apiKey: 16, apiVersion: version, apiName: "ListGroups", encode: async () => new Encoder().writeBuffer(body) },
    response: { decode: async buffer => {
      const r = new Reader(buffer); r.tags(); const throttleTime = r.i32(); const errorCode = r.i16();
      const n = r.count(r.uvar() - 1); const groups = [];
      for (let i = 0; i < n; i++) { const groupId = r.compact(); const protocolType = r.compact(); const groupState = r.compact(); const groupType = version === 5 ? r.compact() : undefined; r.tags(); groups.push({ groupId, protocolType, groupState, ...(groupType === undefined ? {} : { groupType }) }); }
      r.tags(); r.done(); return { throttleTime, errorCode, groups };
    }, parse: async data => data },
  };
}

export function describeGroupsV4(groupIds: string[]): ProtocolRequest {
  const Encoder = require("kafkajs/src/protocol/encoder.js") as new () => { writeBuffer(b: Buffer): unknown };
  const count = Buffer.alloc(4); count.writeInt32BE(groupIds.length);
  const strings = groupIds.map(s => { const b = Buffer.from(s); const n = Buffer.alloc(2); n.writeInt16BE(b.length); return Buffer.concat([n, b]); });
  return {
    request: { apiKey: 15, apiVersion: 4, apiName: "DescribeGroups", encode: async () => new Encoder().writeBuffer(Buffer.concat([count, ...strings, Buffer.from([0])])) },
    response: { decode: async buffer => {
      const r = new Reader(buffer); const throttleTime = r.i32(); const n = r.count(r.i32()); const groups = [];
      for (let i = 0; i < n; i++) {
        const errorCode = r.i16(); const groupId = r.string(); const state = r.string(); const protocolType = r.string(); const protocol = r.string(); const m = r.count(r.i32()); const members = [];
        for (let j = 0; j < m; j++) members.push({ memberId: r.string(), groupInstanceId: r.nullableString(), clientId: r.string(), clientHost: r.string(), memberMetadata: r.bytes(r.i32()), memberAssignment: r.bytes(r.i32()) });
        r.i32(); groups.push({ errorCode, groupId, state, protocolType, protocol, members });
      }
      r.done(); return { throttleTime, groups };
    }, parse: async data => data },
  };
}
