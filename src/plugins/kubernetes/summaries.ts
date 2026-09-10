import type {
  EventsV1Event,
  V1Container,
  V1EndpointSlice,
  V1Ingress,
  V1LabelSelector,
  V1Namespace,
  V1Node,
  V1ObjectMeta,
  V1PersistentVolume,
  V1PersistentVolumeClaim,
  V1Pod,
  V1PodDisruptionBudget,
  V1Service,
  V1StorageClass,
} from "@kubernetes/client-node";
import type { KubernetesWorkload, WorkloadKind } from "./client.js";

export type JsonRecord = Record<string, unknown>;

export function metadataSummary(metadata?: V1ObjectMeta): JsonRecord {
  return compact({
    name: metadata?.name,
    namespace: metadata?.namespace,
    uid: metadata?.uid,
    createdAt: iso(metadata?.creationTimestamp),
    deletionTimestamp: iso(metadata?.deletionTimestamp),
    generation: metadata?.generation,
    labels: metadata?.labels,
  });
}

export function namespaceSummary(namespace: V1Namespace): JsonRecord {
  return compact({
    ...metadataSummary(namespace.metadata),
    phase: namespace.status?.phase,
    conditions: summarizeConditions(namespace.status?.conditions),
  });
}

export function workloadSummary(kind: WorkloadKind, workload: KubernetesWorkload): JsonRecord {
  const base = {
    kind,
    ...metadataSummary(workload.metadata),
  };
  switch (kind) {
    case "Deployment": {
      const value = workload as import("@kubernetes/client-node").V1Deployment;
      return compact({ ...base, desired: value.spec?.replicas, current: value.status?.replicas, ready: value.status?.readyReplicas, available: value.status?.availableReplicas, updated: value.status?.updatedReplicas, unavailable: value.status?.unavailableReplicas, conditions: summarizeConditions(value.status?.conditions), podTemplate: summarizePodTemplate(value.spec?.template.spec?.containers, value.spec?.template.spec?.volumes) });
    }
    case "StatefulSet": {
      const value = workload as import("@kubernetes/client-node").V1StatefulSet;
      return compact({ ...base, serviceName: value.spec?.serviceName, desired: value.spec?.replicas, current: value.status?.currentReplicas, ready: value.status?.readyReplicas, available: value.status?.availableReplicas, updated: value.status?.updatedReplicas, currentRevision: value.status?.currentRevision, updateRevision: value.status?.updateRevision, conditions: summarizeConditions(value.status?.conditions), podTemplate: summarizePodTemplate(value.spec?.template.spec?.containers, value.spec?.template.spec?.volumes) });
    }
    case "DaemonSet": {
      const value = workload as import("@kubernetes/client-node").V1DaemonSet;
      return compact({ ...base, desired: value.status?.desiredNumberScheduled, current: value.status?.currentNumberScheduled, ready: value.status?.numberReady, available: value.status?.numberAvailable, unavailable: value.status?.numberUnavailable, misscheduled: value.status?.numberMisscheduled, updated: value.status?.updatedNumberScheduled, conditions: summarizeConditions(value.status?.conditions), podTemplate: summarizePodTemplate(value.spec?.template.spec?.containers, value.spec?.template.spec?.volumes) });
    }
    case "Job": {
      const value = workload as import("@kubernetes/client-node").V1Job;
      return compact({ ...base, parallelism: value.spec?.parallelism, completions: value.spec?.completions, active: value.status?.active, ready: value.status?.ready, succeeded: value.status?.succeeded, failed: value.status?.failed, startTime: iso(value.status?.startTime), completionTime: iso(value.status?.completionTime), conditions: summarizeConditions(value.status?.conditions), podTemplate: summarizePodTemplate(value.spec?.template.spec?.containers, value.spec?.template.spec?.volumes) });
    }
    case "CronJob": {
      const value = workload as import("@kubernetes/client-node").V1CronJob;
      return compact({ ...base, schedule: value.spec?.schedule, suspend: value.spec?.suspend, concurrencyPolicy: value.spec?.concurrencyPolicy, lastScheduleTime: iso(value.status?.lastScheduleTime), lastSuccessfulTime: iso(value.status?.lastSuccessfulTime), activeJobs: value.status?.active?.map((reference) => compact({ kind: reference.kind, namespace: reference.namespace, name: reference.name, uid: reference.uid })), podTemplate: summarizePodTemplate(value.spec?.jobTemplate.spec?.template.spec?.containers, value.spec?.jobTemplate.spec?.template.spec?.volumes) });
    }
    case "Pod": return podSummary(workload as V1Pod);
  }
}

export function podSummary(pod: V1Pod): JsonRecord {
  const statusByName = new Map((pod.status?.containerStatuses ?? []).map((status) => [status.name, status]));
  return compact({
    kind: "Pod",
    ...metadataSummary(pod.metadata),
    phase: pod.status?.phase,
    reason: pod.status?.reason,
    message: pod.status?.message,
    podIP: pod.status?.podIP,
    nodeName: pod.spec?.nodeName,
    qosClass: pod.status?.qosClass,
    conditions: summarizeConditions(pod.status?.conditions),
    containers: (pod.spec?.containers ?? []).map((container) => summarizeContainer(container, statusByName.get(container.name))),
    initContainers: (pod.spec?.initContainers ?? []).map((container) => summarizeContainer(container, (pod.status?.initContainerStatuses ?? []).find((status) => status.name === container.name))),
    volumes: summarizeVolumes(pod.spec?.volumes),
    ownerReferences: pod.metadata?.ownerReferences?.map((owner) => compact({ kind: owner.kind, name: owner.name, uid: owner.uid, controller: owner.controller })),
  });
}

function summarizeContainer(container: V1Container, status?: import("@kubernetes/client-node").V1ContainerStatus): JsonRecord {
  return compact({
    name: container.name,
    image: container.image,
    command: container.command,
    args: container.args,
    ready: status?.ready,
    started: status?.started,
    restartCount: status?.restartCount,
    imageID: status?.imageID,
    state: summarizeContainerState(status?.state),
    lastState: summarizeContainerState(status?.lastState),
    resources: container.resources === undefined ? undefined : compact({ requests: container.resources.requests, limits: container.resources.limits }),
    probes: compact({ startup: probeSummary(container.startupProbe), readiness: probeSummary(container.readinessProbe), liveness: probeSummary(container.livenessProbe) }),
    environment: (container.env ?? []).map((entry) => compact({
      name: entry.name,
      source: entry.valueFrom?.secretKeyRef !== undefined ? "secretKeyRef" : entry.valueFrom?.configMapKeyRef !== undefined ? "configMapKeyRef" : entry.valueFrom?.fieldRef !== undefined ? "fieldRef" : entry.valueFrom?.resourceFieldRef !== undefined ? "resourceFieldRef" : "literal",
      value: entry.value === undefined ? undefined : "[REDACTED]",
      reference: entry.valueFrom?.secretKeyRef === undefined && entry.valueFrom?.configMapKeyRef === undefined ? undefined : compact({ name: entry.valueFrom.secretKeyRef?.name ?? entry.valueFrom.configMapKeyRef?.name, key: entry.valueFrom.secretKeyRef?.key ?? entry.valueFrom.configMapKeyRef?.key, optional: entry.valueFrom.secretKeyRef?.optional ?? entry.valueFrom.configMapKeyRef?.optional }),
    })),
    environmentFrom: (container.envFrom ?? []).map((entry) => compact({
      prefix: entry.prefix,
      source: entry.secretRef !== undefined ? "secretRef" : "configMapRef",
      reference: compact({ name: entry.secretRef?.name ?? entry.configMapRef?.name, optional: entry.secretRef?.optional ?? entry.configMapRef?.optional }),
    })),
  });
}

function summarizeContainerState(state?: import("@kubernetes/client-node").V1ContainerState): JsonRecord | undefined {
  if (state?.running !== undefined) return compact({ state: "running", startedAt: iso(state.running.startedAt) });
  if (state?.terminated !== undefined) return compact({ state: "terminated", reason: state.terminated.reason, message: state.terminated.message, exitCode: state.terminated.exitCode, signal: state.terminated.signal, startedAt: iso(state.terminated.startedAt), finishedAt: iso(state.terminated.finishedAt) });
  if (state?.waiting !== undefined) return compact({ state: "waiting", reason: state.waiting.reason, message: state.waiting.message });
  return undefined;
}

function probeSummary(probe?: import("@kubernetes/client-node").V1Probe): JsonRecord | undefined {
  if (probe === undefined) return undefined;
  return compact({
    type: probe.httpGet !== undefined ? "httpGet" : probe.tcpSocket !== undefined ? "tcpSocket" : probe.exec !== undefined ? "exec" : probe.grpc !== undefined ? "grpc" : "unknown",
    initialDelaySeconds: probe.initialDelaySeconds,
    periodSeconds: probe.periodSeconds,
    timeoutSeconds: probe.timeoutSeconds,
    failureThreshold: probe.failureThreshold,
    successThreshold: probe.successThreshold,
  });
}

function summarizePodTemplate(containers?: readonly V1Container[], volumes?: readonly import("@kubernetes/client-node").V1Volume[]): JsonRecord {
  return {
    containers: (containers ?? []).map((container) => summarizeContainer(container)),
    volumes: summarizeVolumes(volumes),
  };
}

function summarizeVolumes(volumes?: readonly import("@kubernetes/client-node").V1Volume[]): readonly JsonRecord[] {
  return (volumes ?? []).map((volume) => compact({
    name: volume.name,
    source: volume.persistentVolumeClaim !== undefined ? "persistentVolumeClaim" : volume.secret !== undefined ? "secret" : volume.configMap !== undefined ? "configMap" : volume.projected !== undefined ? "projected" : volume.emptyDir !== undefined ? "emptyDir" : "other",
    reference: volume.persistentVolumeClaim?.claimName ?? volume.secret?.secretName ?? volume.configMap?.name,
    projectedSources: volume.projected?.sources?.map((source) => compact({ secret: source.secret?.name, configMap: source.configMap?.name })),
  }));
}

export function eventSummary(event: EventsV1Event): JsonRecord {
  return compact({
    ...metadataSummary(event.metadata),
    type: event.type,
    reason: event.reason,
    action: event.action,
    note: boundedText(event.note, 2_000),
    regarding: event.regarding === undefined ? undefined : compact({ kind: event.regarding.kind, namespace: event.regarding.namespace, name: event.regarding.name, uid: event.regarding.uid }),
    count: event.series?.count ?? event.deprecatedCount,
    observedAt: iso(event.series?.lastObservedTime ?? event.eventTime ?? event.deprecatedLastTimestamp),
    reportingController: event.reportingController,
  });
}

export function serviceSummary(service: V1Service): JsonRecord {
  return compact({
    ...metadataSummary(service.metadata),
    type: service.spec?.type,
    clusterIP: service.spec?.clusterIP,
    externalName: service.spec?.externalName,
    selector: service.spec?.selector,
    ports: service.spec?.ports?.map((port) => compact({ name: port.name, protocol: port.protocol, port: port.port, targetPort: port.targetPort, nodePort: port.nodePort, appProtocol: port.appProtocol })),
    loadBalancer: service.status?.loadBalancer?.ingress?.map((item) => compact({ hostname: item.hostname, ip: item.ip })),
  });
}

export function endpointSliceSummary(slice: V1EndpointSlice): JsonRecord {
  return compact({
    ...metadataSummary(slice.metadata),
    addressType: slice.addressType,
    ports: slice.ports?.map((port) => compact({ name: port.name, protocol: port.protocol, port: port.port, appProtocol: port.appProtocol })),
    endpoints: slice.endpoints?.map((endpoint) => compact({ addresses: endpoint.addresses, ready: endpoint.conditions?.ready, serving: endpoint.conditions?.serving, terminating: endpoint.conditions?.terminating, hostname: endpoint.hostname, nodeName: endpoint.nodeName, targetRef: endpoint.targetRef === undefined ? undefined : compact({ kind: endpoint.targetRef.kind, namespace: endpoint.targetRef.namespace, name: endpoint.targetRef.name, uid: endpoint.targetRef.uid }) })),
  });
}

const SAFE_NGINX_ANNOTATIONS = new Set([
  "nginx.ingress.kubernetes.io/rewrite-target",
  "nginx.ingress.kubernetes.io/use-regex",
  "nginx.ingress.kubernetes.io/ssl-redirect",
  "nginx.ingress.kubernetes.io/force-ssl-redirect",
  "nginx.ingress.kubernetes.io/backend-protocol",
  "nginx.ingress.kubernetes.io/proxy-read-timeout",
  "nginx.ingress.kubernetes.io/proxy-send-timeout",
  "nginx.ingress.kubernetes.io/proxy-body-size",
  "nginx.ingress.kubernetes.io/service-upstream",
  "nginx.ingress.kubernetes.io/canary",
  "nginx.ingress.kubernetes.io/canary-by-header",
  "nginx.ingress.kubernetes.io/canary-by-header-value",
  "nginx.ingress.kubernetes.io/canary-weight",
  "nginx.ingress.kubernetes.io/whitelist-source-range",
]);

export function ingressSummary(ingress: V1Ingress): JsonRecord {
  const annotations = ingress.metadata?.annotations ?? {};
  return compact({
    ...metadataSummary(ingress.metadata),
    ingressClassName: ingress.spec?.ingressClassName,
    addresses: ingress.status?.loadBalancer?.ingress?.map((item) => compact({ hostname: item.hostname, ip: item.ip })),
    tls: ingress.spec?.tls?.map((tls) => compact({ hosts: tls.hosts, secretName: tls.secretName })),
    annotations: Object.fromEntries(Object.entries(annotations).map(([key, value]) => [key, SAFE_NGINX_ANNOTATIONS.has(key) ? value : "[PRESENT]"])),
    defaultBackend: ingress.spec?.defaultBackend === undefined ? undefined : compact({
      service: ingress.spec.defaultBackend.service === undefined ? undefined : compact({ name: ingress.spec.defaultBackend.service.name, port: ingress.spec.defaultBackend.service.port?.name ?? ingress.spec.defaultBackend.service.port?.number }),
      resourceBackend: ingress.spec.defaultBackend.resource === undefined ? undefined : compact({ apiGroup: ingress.spec.defaultBackend.resource.apiGroup, kind: ingress.spec.defaultBackend.resource.kind, name: ingress.spec.defaultBackend.resource.name }),
    }),
    rules: ingress.spec?.rules?.map((rule) => compact({
      host: rule.host,
      paths: rule.http?.paths.map((path) => compact({
        path: path.path,
        pathType: path.pathType,
        service: path.backend.service === undefined ? undefined : compact({ name: path.backend.service.name, port: path.backend.service.port?.name ?? path.backend.service.port?.number }),
        resourceBackend: path.backend.resource === undefined ? undefined : compact({ apiGroup: path.backend.resource.apiGroup, kind: path.backend.resource.kind, name: path.backend.resource.name }),
      })),
    })),
  });
}

export function nodeSummary(node: V1Node): JsonRecord {
  return compact({
    ...metadataSummary(node.metadata),
    unschedulable: node.spec?.unschedulable,
    conditions: summarizeConditions(node.status?.conditions),
    capacity: node.status?.capacity,
    allocatable: node.status?.allocatable,
  });
}

export function pvcSummary(pvc: V1PersistentVolumeClaim): JsonRecord {
  return compact({ ...metadataSummary(pvc.metadata), phase: pvc.status?.phase, volumeName: pvc.spec?.volumeName, storageClassName: pvc.spec?.storageClassName, accessModes: pvc.spec?.accessModes, requested: pvc.spec?.resources?.requests?.storage, capacity: pvc.status?.capacity?.storage, conditions: summarizeConditions(pvc.status?.conditions) });
}

export function pvSummary(pv: V1PersistentVolume): JsonRecord {
  return compact({ ...metadataSummary(pv.metadata), phase: pv.status?.phase, storageClassName: pv.spec?.storageClassName, capacity: pv.spec?.capacity?.storage, accessModes: pv.spec?.accessModes, volumeMode: pv.spec?.volumeMode, reclaimPolicy: pv.spec?.persistentVolumeReclaimPolicy, claimRef: pv.spec?.claimRef === undefined ? undefined : compact({ namespace: pv.spec.claimRef.namespace, name: pv.spec.claimRef.name, uid: pv.spec.claimRef.uid }), reason: pv.status?.reason });
}

export function storageClassSummary(storageClass: V1StorageClass): JsonRecord {
  return compact({ ...metadataSummary(storageClass.metadata), provisioner: storageClass.provisioner, reclaimPolicy: storageClass.reclaimPolicy, volumeBindingMode: storageClass.volumeBindingMode, allowVolumeExpansion: storageClass.allowVolumeExpansion });
}

export function pdbSummary(pdb: V1PodDisruptionBudget): JsonRecord {
  return compact({ ...metadataSummary(pdb.metadata), minAvailable: pdb.spec?.minAvailable, maxUnavailable: pdb.spec?.maxUnavailable, currentHealthy: pdb.status?.currentHealthy, desiredHealthy: pdb.status?.desiredHealthy, disruptionsAllowed: pdb.status?.disruptionsAllowed, expectedPods: pdb.status?.expectedPods, conditions: summarizeConditions(pdb.status?.conditions) });
}

export function labelsMatch(selector: Readonly<Record<string, string>> | undefined, labels: Readonly<Record<string, string>> | undefined): boolean {
  if (selector === undefined || Object.keys(selector).length === 0 || labels === undefined) return false;
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

export function labelSelectorMatches(selector: V1LabelSelector | undefined, labels: Readonly<Record<string, string>> | undefined): boolean {
  if (selector === undefined || labels === undefined) return false;
  if (!Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value)) return false;
  return (selector.matchExpressions ?? []).every((expression) => {
    const present = Object.hasOwn(labels, expression.key);
    const value = labels[expression.key];
    switch (expression.operator) {
      case "In": return present && (expression.values ?? []).includes(value ?? "");
      case "NotIn": return !present || !(expression.values ?? []).includes(value ?? "");
      case "Exists": return present;
      case "DoesNotExist": return !present;
      default: return false;
    }
  });
}

export function ownerUid(object: { metadata?: V1ObjectMeta }, kind?: string): string | undefined {
  return object.metadata?.ownerReferences?.find((owner) => owner.controller === true && (kind === undefined || owner.kind === kind))?.uid;
}

export function ingressHostMatches(ruleHost: string | undefined, requestedHost: string): boolean {
  if (ruleHost === undefined || ruleHost.length === 0) return true;
  const host = normalizeHost(requestedHost);
  const rule = normalizeHost(ruleHost ?? "");
  if (!rule.startsWith("*.")) return host === rule;
  const suffix = rule.slice(2);
  return host.endsWith(`.${suffix}`) && host.split(".").length === suffix.split(".").length + 1;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function ingressPathMatches(rulePath: string | undefined, pathType: string, requestedPath: string): "match" | "candidate" | "none" {
  const rule = rulePath || "/";
  if (pathType === "Exact") return requestedPath === rule ? "match" : "none";
  if (pathType === "Prefix") {
    if (rule === "/") return "match";
    const normalizedRule = rule.replace(/\/$/, "");
    return requestedPath === normalizedRule || requestedPath.startsWith(`${normalizedRule}/`) ? "match" : "none";
  }
  return "candidate";
}

export function compact<T extends JsonRecord>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function summarizeConditions(conditions?: readonly { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: Date }[]): readonly JsonRecord[] {
  return (conditions ?? []).map((condition) => compact({ type: condition.type, status: condition.status, reason: condition.reason, message: boundedText(condition.message, 1_000), lastTransitionTime: iso(condition.lastTransitionTime) }));
}

function iso(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function boundedText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined || value.length <= maximum) return value;
  return `${value.slice(0, maximum)}…`;
}
