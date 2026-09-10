import { z } from "zod/v4";

const truncation = z.object({
  omittedItems: z.number().int().nonnegative().optional(),
  omittedHits: z.number().int().nonnegative().optional(),
  aggregationsOmitted: z.boolean().optional(),
  omittedFields: z.array(z.string()).optional(),
  message: z.string(),
}).loose().optional();

export const capabilitiesOutputSchema = z.object({
  version: z.string(),
  distribution: z.string(),
  supported: z.boolean(),
  queryDsl: z.boolean(),
  esql: z.boolean(),
  message: z.string(),
});

export const clusterHealthOutputSchema = z.object({
  cluster_name: z.string().optional(),
  status: z.string().optional(),
  number_of_nodes: z.number().optional(),
  number_of_data_nodes: z.number().optional(),
  active_primary_shards: z.number().optional(),
  active_shards: z.number().optional(),
  relocating_shards: z.number().optional(),
  initializing_shards: z.number().optional(),
  unassigned_shards: z.number().optional(),
  delayed_unassigned_shards: z.number().optional(),
  pending_tasks: z.unknown(),
}).loose();

const boundedListBase = {
  status: z.enum(["complete", "truncated"]),
  totalCount: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  truncation,
};

export const indicesOutputSchema = z.object({
  ...boundedListBase,
  indices: z.array(z.object({
    index: z.string(),
    health: z.string().nullable(),
    status: z.string().nullable(),
    primaryShards: z.number().int(),
    replicas: z.number().int(),
    docsCount: z.number().int().nullable(),
    storeBytes: z.number().int().nullable(),
  })),
});

export const shardsOutputSchema = z.object({
  ...boundedListBase,
  shards: z.array(z.object({
    index: z.string(),
    shard: z.number().int(),
    primary: z.boolean(),
    state: z.string(),
    node: z.string().nullable(),
    docs: z.number().int().nullable(),
    storeBytes: z.number().int().nullable(),
    unassignedReason: z.string().nullable(),
  })),
});

export const allocationOutputSchema = z.object({
  index: z.string().optional(),
  shard: z.number().optional(),
  primary: z.boolean().optional(),
  current_state: z.string().optional(),
  unassigned_info: z.unknown().optional(),
  can_allocate: z.string().optional(),
  allocate_explanation: z.string().optional(),
  configured_delay_in_millis: z.number().optional(),
  remaining_delay_in_millis: z.number().optional(),
  node_allocation_decisions: z.unknown().optional(),
  truncation,
}).loose();

export const mappingOutputSchema = z.object({
  status: z.enum(["complete", "truncated"]),
  count: z.number().int().nonnegative(),
  truncation,
  matchedFields: z.number().int().nonnegative(),
  fields: z.array(z.object({
    index: z.string(),
    field: z.string(),
    type: z.string(),
    enabled: z.boolean().optional(),
    indexed: z.boolean().optional(),
    multiField: z.boolean().optional(),
  })),
});

export const fieldCapsOutputSchema = z.object({
  status: z.enum(["complete", "truncated"]),
  count: z.number().int().nonnegative(),
  truncation,
  matchedFields: z.number().int().nonnegative(),
  fields: z.array(z.object({
    field: z.string(),
    conflict: z.boolean(),
    types: z.array(z.object({
      type: z.string(),
      searchable: z.boolean(),
      aggregatable: z.boolean(),
      indices: z.array(z.string()).optional(),
      nonSearchableIndices: z.array(z.string()).optional(),
      nonAggregatableIndices: z.array(z.string()).optional(),
    })),
  })),
});

export const searchOutputSchema = z.object({
  status: z.enum(["complete", "truncated"]),
  tookMs: z.number().int().nonnegative(),
  timedOut: z.boolean(),
  total: z.object({ value: z.number().int().nullable(), relation: z.string() }).optional(),
  hits: z.array(z.object({}).loose()),
  aggregations: z.object({}).loose().optional(),
  shards: z.object({}).loose().optional(),
  truncation,
}).loose();
