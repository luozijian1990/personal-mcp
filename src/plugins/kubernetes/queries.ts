import type {
  V2HorizontalPodAutoscaler,
  V1Ingress,
  V1Job,
  V1NetworkPolicy,
  V1Pod,
  V1ReplicaSet,
  V1Service,
} from "@kubernetes/client-node";
import {
  KUBERNETES_MAX_CONCURRENT_REQUESTS,
  KUBERNETES_MAX_RESPONSE_BYTES,
  KUBERNETES_SNAPSHOT_TIMEOUT_MS,
} from "./constants.js";
import type {
  KubernetesListOptions,
  KubernetesPage,
  KubernetesReadClient,
  KubernetesWorkload,
  WorkloadKind,
} from "./client.js";
import {
  compact,
  endpointSliceSummary,
  eventSummary,
  ingressHostMatches,
  ingressPathMatches,
  ingressSummary,
  labelSelectorMatches,
  labelsMatch,
  metadataSummary,
  namespaceSummary,
  nodeSummary,
  ownerUid,
  pdbSummary,
  podSummary,
  pvSummary,
  pvcSummary,
  resourceQuotaSummary,
  serviceSummary,
  storageClassSummary,
  workloadSummary,
  type JsonRecord,
} from "./summaries.js";

export interface QueryScope {
  readonly namespace?: string | undefined;
  readonly allNamespaces?: boolean | undefined;
}

type SectionStatus = "ok" | "not_found" | "forbidden" | "timeout" | "unsupported" | "truncated" | "error";

interface Section<T> {
  readonly status: SectionStatus;
  readonly data?: T;
  readonly message?: string;
  readonly continueToken?: string;
  readonly continuations?: readonly { readonly resource: string; readonly continueToken: string }[];
}

interface RelatedPods {
  readonly pods: readonly V1Pod[];
  readonly controllers: readonly JsonRecord[];
  readonly podsContinueToken?: string;
  readonly controllersContinueToken?: string;
}

interface ServiceReference {
  readonly namespace: string;
  readonly name: string;
}

export async function listNamespaces(
  client: KubernetesReadClient,
  input: { readonly limit: number; readonly continueToken?: string | undefined; readonly labelSelector?: string | undefined },
): Promise<JsonRecord> {
  const page = await client.listNamespaces({ ...input, limit: input.limit });
  return fitResponse(compact({
    status: page.continueToken === undefined ? "complete" : "truncated",
    count: page.items.length,
    items: page.items.map(namespaceSummary),
    continueToken: page.continueToken,
    resourceVersion: page.resourceVersion,
  }));
}

export async function listWorkloads(
  client: KubernetesReadClient,
  defaultNamespace: string,
  input: QueryScope & { readonly kind: WorkloadKind; readonly limit: number; readonly continueToken?: string | undefined; readonly labelSelector?: string | undefined },
): Promise<JsonRecord> {
  const scope = resolveScope(defaultNamespace, input);
  const page = await client.listWorkloads(input.kind, { ...scope, labelSelector: input.labelSelector, limit: input.limit, continueToken: input.continueToken });
  return fitResponse(compact({
    status: page.continueToken === undefined ? "complete" : "truncated",
    scope,
    kind: input.kind,
    count: page.items.length,
    items: page.items.map((item) => workloadSummary(input.kind, item)),
    continueToken: page.continueToken,
    resourceVersion: page.resourceVersion,
  }));
}

export async function listInfrastructure(
  client: KubernetesReadClient,
  defaultNamespace: string,
  kind: "Node" | "PersistentVolumeClaim" | "ResourceQuota",
  input: QueryScope & { readonly limit: number; readonly continueToken?: string | undefined; readonly labelSelector?: string | undefined },
): Promise<JsonRecord> {
  if (kind === "Node" && (input.namespace !== undefined || input.allNamespaces === true)) throw new Error("Nodes are cluster-scoped; omit namespace and allNamespaces.");
  const scope = kind === "Node" ? {} : resolveScope(defaultNamespace, input);
  const options = { ...scope, limit: input.limit, continueToken: input.continueToken, labelSelector: input.labelSelector };
  const summarizePage = <T>(page: KubernetesPage<T>, summarize: (item: T) => JsonRecord): JsonRecord => {
    const result = compact({
      status: page.continueToken === undefined ? "complete" : "truncated",
      kind, scope, count: page.items.length, items: page.items.map(summarize),
      continueToken: page.continueToken, resourceVersion: page.resourceVersion,
    });
    // A server cursor advances past the entire page. Never trim items while keeping that cursor.
    if (Buffer.byteLength(JSON.stringify(result)) > KUBERNETES_MAX_RESPONSE_BYTES) {
      if (input.limit === 1) throw new Error("A single resource summary exceeded the 256 KiB response budget; this resource cannot be returned by this list tool.");
      throw new Error(`Page exceeded the 256 KiB response budget. Retry the same request with the same continueToken (omit it again for the first page), unchanged filters and limit=${Math.max(1, Math.floor(input.limit / 2))}. No items or next-page cursor were returned.`);
    }
    return result;
  };
  switch (kind) {
    case "Node": return summarizePage(await client.listNodes(options), nodeSummary);
    case "PersistentVolumeClaim": return summarizePage(await client.listPersistentVolumeClaims(options), pvcSummary);
    case "ResourceQuota": return summarizePage(await client.listResourceQuotas(options), resourceQuotaSummary);
  }
}

export async function listEvents(
  client: KubernetesReadClient,
  defaultNamespace: string,
  input: QueryScope & { readonly limit: number; readonly continueToken?: string | undefined; readonly type?: "Normal" | "Warning" | undefined; readonly kind?: string | undefined; readonly name?: string | undefined; readonly sinceSeconds?: number | undefined },
): Promise<JsonRecord> {
  const scope = resolveScope(defaultNamespace, input);
  const page = await client.listEvents({ ...scope, limit: input.limit, continueToken: input.continueToken });
  const cutoff = input.sinceSeconds === undefined ? undefined : Date.now() - input.sinceSeconds * 1000;
  const items = page.items.filter((event) => {
    if (input.type !== undefined && event.type !== input.type) return false;
    if (input.kind !== undefined && event.regarding?.kind !== input.kind) return false;
    if (input.name !== undefined && event.regarding?.name !== input.name) return false;
    if (cutoff !== undefined) {
      const observed = event.series?.lastObservedTime ?? event.eventTime ?? event.deprecatedLastTimestamp;
      if (observed !== undefined && new Date(observed).getTime() < cutoff) return false;
    }
    return true;
  });
  return fitResponse(compact({
    status: page.continueToken === undefined ? "complete" : "truncated",
    scope,
    count: items.length,
    scannedCount: page.items.length,
    items: items.map(eventSummary),
    continueToken: page.continueToken,
    resourceVersion: page.resourceVersion,
  }));
}

export async function getWorkloadSnapshot(
  client: KubernetesReadClient,
  defaultNamespace: string,
  input: { readonly namespace?: string | undefined; readonly kind: WorkloadKind; readonly name: string },
): Promise<JsonRecord> {
  const namespace = input.namespace ?? defaultNamespace;
  return await withSnapshotTimeout(async (signal) => {
    const limitedClient = withConcurrencyLimit(client, KUBERNETES_MAX_CONCURRENT_REQUESTS);
    const target = await limitedClient.getWorkload(input.kind, namespace, input.name, signal);
    const related = await section(() => relatedPods(limitedClient, input.kind, target, namespace, signal));
    const pods = related.data?.pods ?? [];
    const targetUids = new Set([
      target.metadata?.uid,
      ...pods.map((pod) => pod.metadata?.uid),
      ...(related.data?.controllers.map((controller) => controller.uid) ?? []),
    ].filter((uid): uid is string => typeof uid === "string"));
    const [events, serviceObjects, hpas, pdbs, networkPolicies, nodes, storage, resourceQuotas] = await Promise.all([
      pageSection(
        () => limitedClient.listEvents({ namespace, limit: 200, signal }),
        (items) => items.filter((event) => event.regarding?.uid !== undefined && targetUids.has(event.regarding.uid)).map(eventSummary),
      ),
      related.data !== undefined
        ? pageSection(() => limitedClient.listServices(namespace, signal), (items) => matchingServices(items, pods))
        : Promise.resolve(dependencyFailure<readonly V1Service[]>("Related Pods are unavailable.")),
      pageSection(() => limitedClient.listHpas(namespace, signal), (items) => matchingHpas(items, input.kind, input.name).map(hpaSummary)),
      related.data !== undefined
        ? pageSection(() => limitedClient.listPdbs(namespace, signal), (items) => items.filter((pdb) => pods.some((pod) => labelSelectorMatches(pdb.spec?.selector, pod.metadata?.labels))).map(pdbSummary))
        : Promise.resolve(dependencyFailure<readonly JsonRecord[]>("Related Pods are unavailable.")),
      related.data !== undefined
        ? pageSection(() => limitedClient.listNetworkPolicies(namespace, signal), (items) => items.filter((policy) => pods.some((pod) => labelSelectorMatches(policy.spec?.podSelector, pod.metadata?.labels))).map(networkPolicySummary))
        : Promise.resolve(dependencyFailure<readonly JsonRecord[]>("Related Pods are unavailable.")),
      related.data !== undefined
        ? section(async () => await nodeEvidence(limitedClient, pods, signal))
        : Promise.resolve(dependencyFailure<readonly JsonRecord[]>("Related Pods are unavailable.")),
      related.data !== undefined
        ? section(async () => await storageEvidence(limitedClient, namespace, pods, signal))
        : Promise.resolve(dependencyFailure<JsonRecord>("Related Pods are unavailable.")),
      pageSection(() => limitedClient.listResourceQuotas({ namespace, limit: 200, signal }), (items) => items.map(resourceQuotaSummary)),
    ]);
    const services = mapSection(serviceObjects, (items) => items.map(serviceSummary));
    const endpointSlicePages = serviceObjects?.data !== undefined
      ? await multiPageSection(async () => await runLimited((serviceObjects.data ?? []).map((service) => async () => {
        const name = service.metadata?.name;
        if (name === undefined) return { resource: "Service/<unnamed>", page: { items: [] } };
        return { resource: `Service/${name}`, page: await limitedClient.listEndpointSlices(namespace, name, signal) };
      }), KUBERNETES_MAX_CONCURRENT_REQUESTS), (slice, resource) => ({ serviceName: resource.slice("Service/".length), ...endpointSliceSummary(slice) }))
      : dependencyFailure<readonly JsonRecord[]>("Matching Services are unavailable.");
    const endpointSlices = inheritContinuation(endpointSlicePages, "Service", serviceObjects?.continueToken);
    const sections = {
      workload: { status: "ok", data: workloadSummary(input.kind, target) },
      controllers: relatedSection(related, "controllers"),
      pods: relatedSection(related, "pods"),
      events,
      services,
      endpointSlices,
      hpas,
      pdbs,
      networkPolicies,
      nodes,
      storage,
      resourceQuotas,
      references: { status: "ok", data: { configMapsAndSecrets: "names_and_keys_only", referenceChecks: "not_performed" } },
    };
    return fitResponse({
      status: Object.values(sections).some((value) => value?.status !== "ok") ? "partial" : "complete",
      target: { kind: input.kind, namespace, name: input.name },
      sections,
    });
  });
}

export async function getServiceSnapshot(
  client: KubernetesReadClient,
  defaultNamespace: string,
  input: { readonly namespace?: string | undefined; readonly name: string },
): Promise<JsonRecord> {
  const namespace = input.namespace ?? defaultNamespace;
  return await withSnapshotTimeout((signal) => buildServiceSnapshot(withConcurrencyLimit(client, KUBERNETES_MAX_CONCURRENT_REQUESTS), namespace, input.name, signal));
}

export async function getIngressSnapshot(
  client: KubernetesReadClient,
  defaultNamespace: string,
  input: { readonly namespace?: string | undefined; readonly name?: string | undefined; readonly host?: string | undefined; readonly path?: string | undefined },
): Promise<JsonRecord> {
  return await withSnapshotTimeout(async (signal) => {
    const limitedClient = withConcurrencyLimit(client, KUBERNETES_MAX_CONCURRENT_REQUESTS);
    const candidatePage = input.name !== undefined
      ? { items: [await limitedClient.getIngress(input.namespace ?? defaultNamespace, input.name, signal)] }
      : await limitedClient.listIngresses(input.namespace, signal);
    const candidates = candidatePage.items;
    const ingressScanTruncated = candidatePage.continueToken !== undefined;
    const matched = candidates.flatMap((ingress) => matchingIngressRoutes(ingress, input.host, input.path));
    if (matched.length === 0 && !ingressScanTruncated) throw new Error("Ingress route not found. Check namespace, host and path.");
    const serviceReferences = uniqueServiceReferences(matched.flatMap((match) => match.services.map((name) => ({ namespace: match.namespace, name }))));
    const serviceSnapshots = await runLimited(serviceReferences.map((reference) => async () => {
      try {
        const snapshot = await buildServiceSnapshot(limitedClient, reference.namespace, reference.name, signal);
        return { reference, status: snapshot.status, data: snapshot };
      } catch (error) {
        return { reference, ...classifyKubernetesError(error) };
      }
    }), KUBERNETES_MAX_CONCURRENT_REQUESTS);
    return fitResponse({
      status: ingressScanTruncated || serviceSnapshots.some((item) => item.status !== "complete") ? "partial" : "complete",
      target: compact({ kind: "Ingress", namespace: input.namespace, name: input.name, host: input.host, path: input.path }),
      declaredRoutingOnly: true,
      controller: "ingress-nginx",
      ...(matched.length === 0 ? { message: "No matching route was found on the first page, but the Ingress scan is incomplete. Continue or narrow the query before concluding that the route is absent." } : {}),
      ingressScan: ingressScanTruncated
        ? { status: "truncated", scannedCount: candidates.length, continueToken: candidatePage.continueToken, message: "Ingress scan reached the 200-object snapshot limit; narrow by namespace or query by name." }
        : { status: "ok", scannedCount: candidates.length },
      matches: matched.map(({ ingress, routeMatches }) => ({ ingress: ingressSummary(ingress), routeMatches })),
      backendServices: serviceSnapshots,
    });
  });
}

async function buildServiceSnapshot(
  client: KubernetesReadClient,
  namespace: string,
  name: string,
  signal: AbortSignal,
): Promise<JsonRecord> {
  const service = await client.getService(namespace, name, signal);
  const selectedPods: Section<readonly V1Pod[]> = service.spec?.selector === undefined
    ? { status: "ok" as const, data: [] as readonly V1Pod[] }
    : await pageSection(
      () => client.listPods(namespace, selectorString(service.spec?.selector ?? {}), signal),
      (items) => items.filter((pod) => labelsMatch(service.spec?.selector, pod.metadata?.labels)),
    );
  const [endpointSlices, ingresses, replicaSets, jobs] = await Promise.all([
    pageSection(() => client.listEndpointSlices(namespace, name, signal), (items) => items.map(endpointSliceSummary)),
    pageSection(() => client.listIngresses(namespace, signal), (items) => items.filter((ingress) => ingressReferencesService(ingress, name)).map(ingressSummary)),
    pageSection(() => client.listReplicaSets(namespace, signal), (items) => items),
    pageSection(() => client.listJobs(namespace, signal), (items) => items),
  ]);
  const owningWorkloads = selectedPods.data === undefined
    ? dependencyFailure<readonly JsonRecord[]>("Selected Pods are unavailable.")
    : replicaSets.data === undefined || jobs.data === undefined
      ? dependencyFailure<readonly JsonRecord[]>("ReplicaSet or Job ownership data is unavailable.")
      : {
        status: selectedPods.status === "truncated" || replicaSets.status === "truncated" || jobs.status === "truncated" ? "truncated" as const : "ok" as const,
        data: summarizeOwningWorkloads(selectedPods.data, replicaSets.data, jobs.data),
        continuations: [
          selectedPods.continueToken === undefined ? undefined : { resource: "Pod", continueToken: selectedPods.continueToken },
          replicaSets.continueToken === undefined ? undefined : { resource: "ReplicaSet", continueToken: replicaSets.continueToken },
          jobs.continueToken === undefined ? undefined : { resource: "Job", continueToken: jobs.continueToken },
        ].filter((item): item is { resource: string; continueToken: string } => item !== undefined),
      };
  const sections = {
    service: { status: "ok", data: serviceSummary(service) },
    endpointSlices,
    pods: mapSection(selectedPods, (pods) => pods.map(podSummary)),
    owningWorkloads,
    ingresses,
  };
  return fitResponse({
    status: Object.values(sections).some((value) => value.status !== "ok") ? "partial" : "complete",
    target: { kind: "Service", namespace, name },
    sections,
  });
}

export function classifyKubernetesError(error: unknown): { readonly status: "not_found" | "forbidden" | "timeout" | "error"; readonly message: string } {
  const code = typeof error === "object" && error !== null && "code" in error ? Number((error as { code?: unknown }).code) : undefined;
  if (code === 404) return { status: "not_found", message: "Kubernetes resource was not found." };
  if (code === 403) return { status: "forbidden", message: "Kubernetes RBAC denied this read operation." };
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { status: "timeout", message: "Kubernetes read operation timed out." };
  return { status: "error", message: error instanceof Error ? error.message : "Kubernetes read operation failed." };
}

async function relatedPods(client: KubernetesReadClient, kind: WorkloadKind, target: KubernetesWorkload, namespace: string, signal: AbortSignal): Promise<RelatedPods> {
  if (kind === "Pod") return { pods: [target as V1Pod], controllers: [] };
  const podPage = await client.listPods(namespace, undefined, signal);
  const pods = podPage.items;
  const uid = target.metadata?.uid;
  if (uid === undefined) return { pods: [], controllers: [], ...(podPage.continueToken === undefined ? {} : { podsContinueToken: podPage.continueToken }) };
  if (kind === "Deployment") {
    const replicaSetPage = await client.listReplicaSets(namespace, signal);
    const replicaSets = replicaSetPage.items.filter((item) => ownerUid(item, "Deployment") === uid);
    const replicaSetUids = new Set(replicaSets.map((item) => item.metadata?.uid).filter((item): item is string => item !== undefined));
    return { controllers: replicaSets.map((item) => controllerSummary("ReplicaSet", item)), pods: pods.filter((pod) => {
      const owner = ownerUid(pod, "ReplicaSet");
      return owner !== undefined && replicaSetUids.has(owner);
    }), ...(podPage.continueToken === undefined ? {} : { podsContinueToken: podPage.continueToken }), ...(replicaSetPage.continueToken === undefined ? {} : { controllersContinueToken: replicaSetPage.continueToken }) };
  }
  if (kind === "CronJob") {
    const jobPage = await client.listJobs(namespace, signal);
    const jobs = jobPage.items.filter((item) => ownerUid(item, "CronJob") === uid);
    const jobUids = new Set(jobs.map((item) => item.metadata?.uid).filter((item): item is string => item !== undefined));
    return { controllers: jobs.map((item) => controllerSummary("Job", item)), pods: pods.filter((pod) => {
      const owner = ownerUid(pod, "Job");
      return owner !== undefined && jobUids.has(owner);
    }), ...(podPage.continueToken === undefined ? {} : { podsContinueToken: podPage.continueToken }), ...(jobPage.continueToken === undefined ? {} : { controllersContinueToken: jobPage.continueToken }) };
  }
  return { controllers: [], pods: pods.filter((pod) => ownerUid(pod, kind) === uid), ...(podPage.continueToken === undefined ? {} : { podsContinueToken: podPage.continueToken }) };
}

function controllerSummary(kind: "ReplicaSet" | "Job", controller: V1ReplicaSet | V1Job): JsonRecord {
  if (kind === "ReplicaSet") {
    const replicaSet = controller as V1ReplicaSet;
    return compact({ kind, ...metadataSummary(replicaSet.metadata), desired: replicaSet.spec?.replicas, current: replicaSet.status?.replicas, ready: replicaSet.status?.readyReplicas, available: replicaSet.status?.availableReplicas });
  }
  const job = controller as V1Job;
  return compact({ kind, ...metadataSummary(job.metadata), active: job.status?.active, ready: job.status?.ready, succeeded: job.status?.succeeded, failed: job.status?.failed });
}

function matchingServices(services: readonly V1Service[], pods: readonly V1Pod[]): readonly V1Service[] {
  return services.filter((service) => pods.some((pod) => labelsMatch(service.spec?.selector, pod.metadata?.labels)));
}

function matchingHpas(hpas: readonly V2HorizontalPodAutoscaler[], kind: WorkloadKind, name: string): readonly V2HorizontalPodAutoscaler[] {
  return hpas.filter((hpa) => hpa.spec?.scaleTargetRef.kind === kind && hpa.spec.scaleTargetRef.name === name);
}

function hpaSummary(hpa: V2HorizontalPodAutoscaler): JsonRecord {
  return compact({ ...metadataSummary(hpa.metadata), target: hpa.spec === undefined ? undefined : compact({ apiVersion: hpa.spec.scaleTargetRef.apiVersion, kind: hpa.spec.scaleTargetRef.kind, name: hpa.spec.scaleTargetRef.name }), minReplicas: hpa.spec?.minReplicas, maxReplicas: hpa.spec?.maxReplicas, currentReplicas: hpa.status?.currentReplicas, desiredReplicas: hpa.status?.desiredReplicas, conditions: hpa.status?.conditions?.map((condition) => compact({ type: condition.type, status: condition.status, reason: condition.reason, message: condition.message })) });
}

function networkPolicySummary(policy: V1NetworkPolicy): JsonRecord {
  return compact({ ...metadataSummary(policy.metadata), podSelector: policy.spec?.podSelector, policyTypes: policy.spec?.policyTypes, ingressRuleCount: policy.spec?.ingress?.length ?? 0, egressRuleCount: policy.spec?.egress?.length ?? 0 });
}

async function nodeEvidence(client: KubernetesReadClient, pods: readonly V1Pod[], signal: AbortSignal): Promise<readonly JsonRecord[]> {
  const names = [...new Set(pods.map((pod) => pod.spec?.nodeName).filter((name): name is string => name !== undefined))];
  return await runLimited(names.map((name) => async () => nodeSummary(await client.getNode(name, signal))), KUBERNETES_MAX_CONCURRENT_REQUESTS);
}

async function storageEvidence(client: KubernetesReadClient, namespace: string, pods: readonly V1Pod[], signal: AbortSignal): Promise<JsonRecord> {
  const claimNames = [...new Set(pods.flatMap((pod) => pod.spec?.volumes?.map((volume) => volume.persistentVolumeClaim?.claimName).filter((name): name is string => name !== undefined) ?? []))];
  const pvcs = await runLimited(claimNames.map((name) => () => client.getPersistentVolumeClaim(namespace, name, signal)), KUBERNETES_MAX_CONCURRENT_REQUESTS);
  const volumeNames = [...new Set(pvcs.map((pvc) => pvc.spec?.volumeName).filter((name): name is string => name !== undefined))];
  const pvs = await runLimited(volumeNames.map((name) => () => client.getPersistentVolume(name, signal)), KUBERNETES_MAX_CONCURRENT_REQUESTS);
  const classNames = [...new Set([...pvcs.map((pvc) => pvc.spec?.storageClassName), ...pvs.map((pv) => pv.spec?.storageClassName)].filter((name): name is string => name !== undefined))];
  const classes = await runLimited(classNames.map((name) => () => client.getStorageClass(name, signal)), KUBERNETES_MAX_CONCURRENT_REQUESTS);
  return { persistentVolumeClaims: pvcs.map(pvcSummary), persistentVolumes: pvs.map(pvSummary), storageClasses: classes.map(storageClassSummary) };
}

function ingressReferencesService(ingress: V1Ingress, serviceName: string): boolean {
  if (ingress.spec?.defaultBackend?.service?.name === serviceName) return true;
  return (ingress.spec?.rules ?? []).some((rule) => rule.http?.paths.some((path) => path.backend.service?.name === serviceName) ?? false);
}

function matchingIngressRoutes(ingress: V1Ingress, host?: string, requestedPath?: string): readonly { ingress: V1Ingress; namespace: string; services: readonly string[]; routeMatches: readonly JsonRecord[] }[] {
  const namespace = ingress.metadata?.namespace ?? "default";
  const regexEnabled = ingress.metadata?.annotations?.["nginx.ingress.kubernetes.io/use-regex"]?.toLowerCase() === "true";
  const ruleMatches = (ingress.spec?.rules ?? []).flatMap((rule) => {
    if (host !== undefined && !ingressHostMatches(rule.host, host)) return [];
    return (rule.http?.paths ?? []).flatMap((path) => {
      const implementationSpecific = path.pathType === "ImplementationSpecific" || regexEnabled;
      const match = implementationSpecific
        ? "candidate"
        : requestedPath === undefined
          ? "match"
          : ingressPathMatches(path.path, path.pathType, requestedPath);
      if (match === "none") return [];
      return [compact({ host: rule.host, path: path.path, pathType: path.pathType, match, serviceName: path.backend.service?.name, servicePort: path.backend.service?.port?.name ?? path.backend.service?.port?.number })];
    });
  });
  const defaultService = ingress.spec?.defaultBackend?.service;
  const defaultMatches = defaultService === undefined || host !== undefined
    ? []
    : [compact({ path: "<defaultBackend>", pathType: "ImplementationSpecific", match: "candidate", serviceName: defaultService.name, servicePort: defaultService.port?.name ?? defaultService.port?.number })];
  const routeMatches = [...ruleMatches, ...defaultMatches].sort((left, right) => {
    const matchOrder = String(left.match) === String(right.match) ? 0 : String(left.match) === "match" ? -1 : 1;
    const lengthOrder = String(right.path ?? "").length - String(left.path ?? "").length;
    const typeOrder = left.pathType === right.pathType ? 0 : left.pathType === "Exact" ? -1 : right.pathType === "Exact" ? 1 : 0;
    return matchOrder || lengthOrder || typeOrder;
  });
  if (routeMatches.length === 0 && host !== undefined) return [];
  const services = routeMatches.map((route) => route.serviceName).filter((name): name is string => typeof name === "string");
  return [{ ingress, namespace, services, routeMatches }];
}

function summarizeOwningWorkloads(pods: readonly V1Pod[], replicaSets: readonly V1ReplicaSet[], jobs: readonly V1Job[]): readonly JsonRecord[] {
  const replicaSetByUid = new Map(replicaSets.map((item) => [item.metadata?.uid, item]));
  const jobByUid = new Map(jobs.map((item) => [item.metadata?.uid, item]));
  const owners = pods.flatMap((pod) => {
    const owner = pod.metadata?.ownerReferences?.find((reference) => reference.controller === true);
    if (owner === undefined) return [];
    if (owner.kind === "ReplicaSet") {
      const replicaSet = replicaSetByUid.get(owner.uid);
      const deployment = replicaSet?.metadata?.ownerReferences?.find((reference) => reference.controller === true && reference.kind === "Deployment");
      return [compact({ kind: deployment?.kind ?? owner.kind, namespace: pod.metadata?.namespace, name: deployment?.name ?? owner.name, uid: deployment?.uid ?? owner.uid })];
    }
    if (owner.kind === "Job") {
      const job = jobByUid.get(owner.uid);
      const cronJob = job?.metadata?.ownerReferences?.find((reference) => reference.controller === true && reference.kind === "CronJob");
      return [compact({ kind: cronJob?.kind ?? owner.kind, namespace: pod.metadata?.namespace, name: cronJob?.name ?? owner.name, uid: cronJob?.uid ?? owner.uid })];
    }
    return [compact({ kind: owner.kind, namespace: pod.metadata?.namespace, name: owner.name, uid: owner.uid })];
  });
  return [...new Map(owners.map((owner) => [`${owner.kind}/${owner.namespace}/${owner.name}`, owner])).values()];
}

function selectorString(selector: Readonly<Record<string, string>>): string {
  return Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(",");
}

function uniqueServiceReferences(references: readonly ServiceReference[]): readonly ServiceReference[] {
  return [...new Map(references.map((reference) => [`${reference.namespace.length}:${reference.namespace}${reference.name.length}:${reference.name}`, reference])).values()];
}

function resolveScope(defaultNamespace: string, input: QueryScope): { readonly namespace?: string; readonly allNamespaces?: boolean } {
  if (input.namespace !== undefined && input.allNamespaces === true) throw new Error("namespace and allNamespaces are mutually exclusive");
  if (input.allNamespaces === true) return { allNamespaces: true };
  return { namespace: input.namespace ?? defaultNamespace };
}

async function section<T>(operation: () => Promise<T>): Promise<Section<T>> {
  try {
    return { status: "ok", data: await operation() };
  } catch (error) {
    return classifyKubernetesError(error);
  }
}

function mapSection<T, U>(value: Section<T> | undefined, mapper: (data: T) => U): Section<U> {
  if (value === undefined) return { status: "error", message: "Missing section result." };
  if (value.data === undefined) return { status: value.status, ...(value.message === undefined ? {} : { message: value.message }) };
  return {
    status: value.status,
    data: mapper(value.data),
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.continueToken === undefined ? {} : { continueToken: value.continueToken }),
    ...(value.continuations === undefined ? {} : { continuations: value.continuations }),
  };
}

function relatedSection(value: Section<RelatedPods>, part: "pods" | "controllers"): Section<readonly JsonRecord[]> {
  if (value.data === undefined) return { status: value.status, ...(value.message === undefined ? {} : { message: value.message }) };
  const continuations = [
    part === "pods" && value.data.podsContinueToken !== undefined ? { resource: "Pod", continueToken: value.data.podsContinueToken } : undefined,
    value.data.controllersContinueToken !== undefined ? { resource: "Controller", continueToken: value.data.controllersContinueToken } : undefined,
  ].filter((item): item is { resource: string; continueToken: string } => item !== undefined);
  const data = part === "pods" ? value.data.pods.map(podSummary) : value.data.controllers;
  return {
    status: continuations.length === 0 ? "ok" : "truncated",
    data,
    ...(continuations.length === 0 ? {} : { continuations, message: `${part} relationship query is incomplete.` }),
  };
}

function inheritContinuation<T>(value: Section<T>, resource: string, continueToken: string | undefined): Section<T> {
  if (continueToken === undefined) return value;
  return {
    ...value,
    status: "truncated",
    message: "An upstream Kubernetes relationship query is incomplete.",
    continuations: [{ resource, continueToken }, ...(value.continuations ?? [])],
  };
}

async function pageSection<T, U>(
  operation: () => Promise<KubernetesPage<T>>,
  mapper: (items: readonly T[]) => U,
): Promise<Section<U>> {
  try {
    const page = await operation();
    return {
      status: page.continueToken === undefined ? "ok" : "truncated",
      data: mapper(page.items),
      ...(page.continueToken === undefined ? {} : { continueToken: page.continueToken, message: "Kubernetes returned a continuation token; this section is incomplete." }),
    };
  } catch (error) {
    return classifyKubernetesError(error);
  }
}

async function multiPageSection<T, U>(
  operation: () => Promise<readonly { readonly resource: string; readonly page: KubernetesPage<T> }[]>,
  mapper: (item: T, resource: string) => U,
): Promise<Section<readonly U[]>> {
  try {
    const results = await operation();
    const continuations = results.flatMap(({ resource, page }) => page.continueToken === undefined ? [] : [{ resource, continueToken: page.continueToken }]);
    return {
      status: continuations.length === 0 ? "ok" : "truncated",
      data: results.flatMap(({ resource, page }) => page.items.map((item) => mapper(item, resource))),
      ...(continuations.length === 0 ? {} : { continuations, message: "One or more Kubernetes related-resource queries are incomplete." }),
    };
  } catch (error) {
    return classifyKubernetesError(error);
  }
}

function dependencyFailure<T>(message: string): Section<T> {
  return { status: "error", message };
}

async function withSnapshotTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return await operation(AbortSignal.timeout(KUBERNETES_SNAPSHOT_TIMEOUT_MS));
}

async function runLimited<T>(tasks: readonly (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      if (task !== undefined) results[index] = await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function withConcurrencyLimit(client: KubernetesReadClient, concurrency: number): KubernetesReadClient {
  const run = createPromiseGate(concurrency);
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => run(async () => await Reflect.apply(value, target, args) as unknown);
    },
  }) as KubernetesReadClient;
}

function createPromiseGate(concurrency: number): <T>(operation: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

export function fitResponse(value: JsonRecord): JsonRecord {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes <= KUBERNETES_MAX_RESPONSE_BYTES) return value;
  const reduced = reduceValue(value) as JsonRecord;
  const reducedBytes = Buffer.byteLength(JSON.stringify(reduced));
  if (reducedBytes <= KUBERNETES_MAX_RESPONSE_BYTES) {
    const candidate = { ...reduced, status: "truncated", truncation: { originalBytes: bytes, returnedBytes: reducedBytes, message: "Large arrays and strings were reduced to fit the response budget." } };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= KUBERNETES_MAX_RESPONSE_BYTES) return candidate;
  }
  return { status: "truncated", truncation: { originalBytes: bytes, message: "Response exceeded the 256 KiB budget. Add namespace or label filters." }, topLevelKeys: Object.keys(value) };
}

function reduceValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(reduceValue);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reduceValue(item)]));
  return value;
}
