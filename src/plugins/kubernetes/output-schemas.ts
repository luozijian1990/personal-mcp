import { z } from "zod/v4";

const resultStatus = z.enum(["complete", "partial", "truncated"]);
const sectionStatus = z.enum(["ok", "not_found", "forbidden", "timeout", "unsupported", "truncated", "error"]);
const summary = z.object({
  name: z.string().optional(),
  namespace: z.string().optional(),
  uid: z.string().optional(),
}).loose();
const section = z.object({
  status: sectionStatus,
  data: z.unknown().optional(),
  message: z.string().optional(),
  continueToken: z.string().optional(),
  continuations: z.array(z.object({ resource: z.string(), continueToken: z.string() })).optional(),
}).loose();
const target = z.object({
  kind: z.string(),
  namespace: z.string().optional(),
  name: z.string().optional(),
}).loose();
const truncation = z.object({
  originalBytes: z.number(),
  returnedBytes: z.number().optional(),
  message: z.string(),
}).optional();

export const namespaceListOutputSchema = z.object({
  status: resultStatus,
  count: z.number().int().nonnegative().optional(),
  items: z.array(summary.extend({ phase: z.string().optional() })).optional(),
  continueToken: z.string().optional(),
  resourceVersion: z.string().optional(),
  truncation,
}).loose();

export const workloadListOutputSchema = z.object({
  status: resultStatus,
  scope: z.object({ namespace: z.string().optional(), allNamespaces: z.boolean().optional() }).optional(),
  kind: z.enum(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod"]).optional(),
  count: z.number().int().nonnegative().optional(),
  items: z.array(summary.extend({ kind: z.string() })).optional(),
  continueToken: z.string().optional(),
  resourceVersion: z.string().optional(),
  truncation,
}).loose();

export const workloadSnapshotOutputSchema = z.object({
  status: resultStatus,
  target: target.optional(),
  sections: z.object({
    workload: section,
    controllers: section,
    pods: section,
    events: section,
    services: section,
    endpointSlices: section,
    hpas: section,
    pdbs: section,
    networkPolicies: section,
    nodes: section,
    storage: section,
    references: section,
  }).optional(),
  truncation,
}).loose();

export const serviceSnapshotOutputSchema = z.object({
  status: resultStatus,
  target: target.optional(),
  sections: z.object({
    service: section,
    endpointSlices: section,
    pods: section,
    owningWorkloads: section,
    ingresses: section,
  }).optional(),
  truncation,
}).loose();

export const ingressSnapshotOutputSchema = z.object({
  status: resultStatus,
  target: target.optional(),
  declaredRoutingOnly: z.boolean().optional(),
  controller: z.string().optional(),
  ingressScan: z.object({ status: z.enum(["ok", "truncated"]), scannedCount: z.number().int().nonnegative(), continueToken: z.string().optional(), message: z.string().optional() }).optional(),
  matches: z.array(z.object({ ingress: summary, routeMatches: z.array(z.object({ path: z.string().optional(), pathType: z.string().optional(), match: z.enum(["match", "candidate"]), serviceName: z.string().optional(), servicePort: z.union([z.string(), z.number()]).optional() }).loose()) })).optional(),
  backendServices: z.array(z.object({ reference: z.object({ namespace: z.string(), name: z.string() }), status: z.enum(["complete", "partial", "truncated", "not_found", "forbidden", "timeout", "error"]), data: z.unknown().optional(), message: z.string().optional() })).optional(),
  truncation,
}).loose();

export const eventListOutputSchema = z.object({
  status: resultStatus,
  scope: z.object({ namespace: z.string().optional(), allNamespaces: z.boolean().optional() }).optional(),
  count: z.number().int().nonnegative().optional(),
  scannedCount: z.number().int().nonnegative().optional(),
  items: z.array(summary.extend({ type: z.string().optional(), reason: z.string().optional(), note: z.string().optional() })).optional(),
  continueToken: z.string().optional(),
  resourceVersion: z.string().optional(),
  truncation,
}).loose();

export const podLogsOutputSchema = z.object({
  status: resultStatus,
  namespace: z.string().optional(),
  pod: z.string().optional(),
  container: z.string().optional(),
  previous: z.boolean().optional(),
  tailLines: z.number().int().positive().optional(),
  truncated: z.boolean().optional(),
  log: z.string().optional(),
  truncation,
}).loose();
