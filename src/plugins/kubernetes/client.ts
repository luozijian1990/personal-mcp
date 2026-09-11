import { access } from "node:fs/promises";
import path from "node:path";
import {
  AppsV1Api,
  AutoscalingV2Api,
  BatchV1Api,
  CoreApi,
  CoreV1Api,
  DiscoveryV1Api,
  EventsV1Api,
  KubeConfig,
  NetworkingV1Api,
  PolicyV1Api,
  StorageV1Api,
  VersionApi,
  type CoreV1ApiReadNamespacedPodLogRequest,
  type EventsV1Event,
  Observable,
  type ObservableMiddleware,
  type RequestContext,
  type ResponseContext,
  type V1CronJob,
  type V1DaemonSet,
  type V1Deployment,
  type V1EndpointSlice,
  type V2HorizontalPodAutoscaler,
  type V1Ingress,
  type V1Job,
  type V1Namespace,
  type V1NetworkPolicy,
  type V1Node,
  type V1PersistentVolume,
  type V1PersistentVolumeClaim,
  type V1Pod,
  type V1ResourceQuota,
  type V1PodDisruptionBudget,
  type V1ReplicaSet,
  type V1Service,
  type V1StatefulSet,
  type V1StorageClass,
  type VersionInfo,
} from "@kubernetes/client-node";
import { KUBERNETES_REQUEST_TIMEOUT_MS } from "./constants.js";
import type { KubernetesPluginConfig } from "./config.js";

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "CronJob" | "Pod";
export type KubernetesWorkload = V1Deployment | V1StatefulSet | V1DaemonSet | V1Job | V1CronJob | V1Pod;

export interface KubernetesPage<T> {
  readonly items: readonly T[];
  readonly continueToken?: string;
  readonly resourceVersion?: string;
}

export interface KubernetesListOptions {
  readonly namespace?: string | undefined;
  readonly allNamespaces?: boolean | undefined;
  readonly labelSelector?: string | undefined;
  readonly fieldSelector?: string | undefined;
  readonly limit: number;
  readonly continueToken?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface KubernetesReadClient {
  getVersion(signal?: AbortSignal): Promise<VersionInfo>;
  getApiVersions(signal?: AbortSignal): Promise<unknown>;
  listNamespaces(options: KubernetesListOptions): Promise<KubernetesPage<V1Namespace>>;
  listWorkloads(kind: WorkloadKind, options: KubernetesListOptions): Promise<KubernetesPage<KubernetesWorkload>>;
  getWorkload(kind: WorkloadKind, namespace: string, name: string, signal?: AbortSignal): Promise<KubernetesWorkload>;
  listPods(namespace: string, labelSelector?: string, signal?: AbortSignal): Promise<KubernetesPage<V1Pod>>;
  listReplicaSets(namespace: string, signal?: AbortSignal): Promise<KubernetesPage<V1ReplicaSet>>;
  listJobs(namespace: string, signal?: AbortSignal): Promise<KubernetesPage<V1Job>>;
  listNodes(options: KubernetesListOptions): Promise<KubernetesPage<V1Node>>;
  listPersistentVolumeClaims(options: KubernetesListOptions): Promise<KubernetesPage<V1PersistentVolumeClaim>>;
  listResourceQuotas(options: KubernetesListOptions): Promise<KubernetesPage<V1ResourceQuota>>;
  getNode(name: string, signal?: AbortSignal): Promise<V1Node>;
  getPersistentVolumeClaim(namespace: string, name: string, signal?: AbortSignal): Promise<V1PersistentVolumeClaim>;
  getPersistentVolume(name: string, signal?: AbortSignal): Promise<V1PersistentVolume>;
  getStorageClass(name: string, signal?: AbortSignal): Promise<V1StorageClass>;
  listServices(namespace: string, signal?: AbortSignal): Promise<KubernetesPage<V1Service>>;
  getService(namespace: string, name: string, signal?: AbortSignal): Promise<V1Service>;
  listEndpointSlices(namespace: string, serviceName?: string, signal?: AbortSignal): Promise<KubernetesPage<V1EndpointSlice>>;
  listIngresses(namespace: string | undefined, signal?: AbortSignal): Promise<KubernetesPage<V1Ingress>>;
  getIngress(namespace: string, name: string, signal?: AbortSignal): Promise<V1Ingress>;
  listEvents(options: KubernetesListOptions): Promise<KubernetesPage<EventsV1Event>>;
  listHpas(namespace: string, signal?: AbortSignal): Promise<KubernetesPage<V2HorizontalPodAutoscaler>>;
  listPdbs(namespace: string, signal?: AbortSignal): Promise<KubernetesPage<V1PodDisruptionBudget>>;
  listNetworkPolicies(namespace: string, signal?: AbortSignal): Promise<KubernetesPage<V1NetworkPolicy>>;
  getPodLogs(input: Omit<CoreV1ApiReadNamespacedPodLogRequest, "follow" | "insecureSkipTLSVerifyBackend">, signal?: AbortSignal): Promise<string>;
}

export async function validateKubernetesConfig(config: KubernetesPluginConfig): Promise<void> {
  if (!config.kubeconfigPath) throw new Error("KUBERNETES_KUBECONFIG_PATH must be configured");
  if (!config.context) throw new Error("KUBERNETES_CONTEXT must be configured");
  if (!config.defaultNamespace) throw new Error("KUBERNETES_DEFAULT_NAMESPACE must be configured");
  if (!path.isAbsolute(config.kubeconfigPath)) throw new Error("KUBERNETES_KUBECONFIG_PATH must be an absolute path");
  if (!isNamespace(config.defaultNamespace)) throw new Error("KUBERNETES_DEFAULT_NAMESPACE must be a valid DNS label");
  await access(config.kubeconfigPath);
  createKubeConfig(config);
}

export function isNamespace(value: string): boolean {
  return value.length <= 63 && /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value);
}

export function createKubernetesReadClient(config: KubernetesPluginConfig): KubernetesReadClient {
  const kubeconfig = createKubeConfig(config);
  const apps = kubeconfig.makeApiClient(AppsV1Api);
  const autoscaling = kubeconfig.makeApiClient(AutoscalingV2Api);
  const batch = kubeconfig.makeApiClient(BatchV1Api);
  const core = kubeconfig.makeApiClient(CoreV1Api);
  const coreDiscovery = kubeconfig.makeApiClient(CoreApi);
  const discovery = kubeconfig.makeApiClient(DiscoveryV1Api);
  const events = kubeconfig.makeApiClient(EventsV1Api);
  const networking = kubeconfig.makeApiClient(NetworkingV1Api);
  const policy = kubeconfig.makeApiClient(PolicyV1Api);
  const storage = kubeconfig.makeApiClient(StorageV1Api);
  const version = kubeconfig.makeApiClient(VersionApi);

  const options = (signal?: AbortSignal) => ({ middleware: [new ReadOnlyMiddleware(signal)] });
  const listOptions = (input: KubernetesListOptions) => ({
    ...(input.continueToken === undefined ? {} : { _continue: input.continueToken }),
    ...(input.fieldSelector === undefined ? {} : { fieldSelector: input.fieldSelector }),
    ...(input.labelSelector === undefined ? {} : { labelSelector: input.labelSelector }),
    limit: input.limit,
    timeoutSeconds: Math.ceil(KUBERNETES_REQUEST_TIMEOUT_MS / 1000),
    watch: false,
  });
  const page = <TItem>(value: { metadata?: { _continue?: string; resourceVersion?: string }; items: TItem[] }): KubernetesPage<TItem> => ({
    items: value.items,
    ...(value.metadata?._continue === undefined ? {} : { continueToken: value.metadata._continue }),
    ...(value.metadata?.resourceVersion === undefined ? {} : { resourceVersion: value.metadata.resourceVersion }),
  });

  return {
    getVersion: (signal) => withTimeout(signal, (requestSignal) => version.getCode({}, options(requestSignal))),
    getApiVersions: (signal) => withTimeout(signal, (requestSignal) => coreDiscovery.getAPIVersions({}, options(requestSignal))),
    listNamespaces: (input) => withTimeout(input.signal, async (signal) => page(await core.listNamespace(listOptions(input), options(signal)))),
    listWorkloads: (kind, input) => withTimeout(input.signal, async (signal) => {
      const list = listOptions(input);
      switch (kind) {
        case "Deployment": return page(input.allNamespaces ? await apps.listDeploymentForAllNamespaces(list, options(signal)) : await apps.listNamespacedDeployment({ namespace: requiredNamespace(input), ...list }, options(signal)));
        case "StatefulSet": return page(input.allNamespaces ? await apps.listStatefulSetForAllNamespaces(list, options(signal)) : await apps.listNamespacedStatefulSet({ namespace: requiredNamespace(input), ...list }, options(signal)));
        case "DaemonSet": return page(input.allNamespaces ? await apps.listDaemonSetForAllNamespaces(list, options(signal)) : await apps.listNamespacedDaemonSet({ namespace: requiredNamespace(input), ...list }, options(signal)));
        case "Job": return page(input.allNamespaces ? await batch.listJobForAllNamespaces(list, options(signal)) : await batch.listNamespacedJob({ namespace: requiredNamespace(input), ...list }, options(signal)));
        case "CronJob": return page(input.allNamespaces ? await batch.listCronJobForAllNamespaces(list, options(signal)) : await batch.listNamespacedCronJob({ namespace: requiredNamespace(input), ...list }, options(signal)));
        case "Pod": return page(input.allNamespaces ? await core.listPodForAllNamespaces(list, options(signal)) : await core.listNamespacedPod({ namespace: requiredNamespace(input), ...list }, options(signal)));
      }
    }),
    getWorkload: (kind, namespace, name, signal) => withTimeout<KubernetesWorkload>(signal, async (requestSignal) => {
      switch (kind) {
        case "Deployment": return await apps.readNamespacedDeployment({ namespace, name }, options(requestSignal));
        case "StatefulSet": return await apps.readNamespacedStatefulSet({ namespace, name }, options(requestSignal));
        case "DaemonSet": return await apps.readNamespacedDaemonSet({ namespace, name }, options(requestSignal));
        case "Job": return await batch.readNamespacedJob({ namespace, name }, options(requestSignal));
        case "CronJob": return await batch.readNamespacedCronJob({ namespace, name }, options(requestSignal));
        case "Pod": return await core.readNamespacedPod({ namespace, name }, options(requestSignal));
      }
    }),
    listPods: (namespace, labelSelector, signal) => withTimeout(signal, async (requestSignal) => page(await core.listNamespacedPod({ namespace, ...(labelSelector === undefined ? {} : { labelSelector }), limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)))),
    listReplicaSets: (namespace, signal) => withTimeout(signal, async (requestSignal) => page(await apps.listNamespacedReplicaSet({ namespace, limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)))),
    listJobs: (namespace, signal) => withTimeout(signal, async (requestSignal) => page(await batch.listNamespacedJob({ namespace, limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)))),
    listNodes: (input) => withTimeout(input.signal, async (signal) => page(await core.listNode(listOptions(input), options(signal)))),
    listPersistentVolumeClaims: (input) => withTimeout(input.signal, async (signal) => page(input.allNamespaces ? await core.listPersistentVolumeClaimForAllNamespaces(listOptions(input), options(signal)) : await core.listNamespacedPersistentVolumeClaim({ namespace: requiredNamespace(input), ...listOptions(input) }, options(signal)))),
    listResourceQuotas: (input) => withTimeout(input.signal, async (signal) => page(input.allNamespaces ? await core.listResourceQuotaForAllNamespaces(listOptions(input), options(signal)) : await core.listNamespacedResourceQuota({ namespace: requiredNamespace(input), ...listOptions(input) }, options(signal)))),
    getNode: (name, signal) => withTimeout(signal, (requestSignal) => core.readNode({ name }, options(requestSignal))),
    getPersistentVolumeClaim: (namespace, name, signal) => withTimeout(signal, (requestSignal) => core.readNamespacedPersistentVolumeClaim({ namespace, name }, options(requestSignal))),
    getPersistentVolume: (name, signal) => withTimeout(signal, (requestSignal) => core.readPersistentVolume({ name }, options(requestSignal))),
    getStorageClass: (name, signal) => withTimeout(signal, (requestSignal) => storage.readStorageClass({ name }, options(requestSignal))),
    listServices: (namespace, signal) => withTimeout(signal, async (requestSignal) => page(await core.listNamespacedService({ namespace, limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)))),
    getService: (namespace, name, signal) => withTimeout(signal, (requestSignal) => core.readNamespacedService({ namespace, name }, options(requestSignal))),
    listEndpointSlices: (namespace, serviceName, signal) => withTimeout(signal, async (requestSignal) => page(await discovery.listNamespacedEndpointSlice({ namespace, ...(serviceName === undefined ? {} : { labelSelector: `kubernetes.io/service-name=${serviceName}` }), limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)))),
    listIngresses: (namespace, signal) => withTimeout(signal, async (requestSignal) => page(namespace === undefined ? await networking.listIngressForAllNamespaces({ limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)) : await networking.listNamespacedIngress({ namespace, limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)))),
    getIngress: (namespace, name, signal) => withTimeout(signal, (requestSignal) => networking.readNamespacedIngress({ namespace, name }, options(requestSignal))),
    listEvents: (input) => withTimeout(input.signal, async (signal) => page(input.allNamespaces ? await events.listEventForAllNamespaces(listOptions(input), options(signal)) : await events.listNamespacedEvent({ namespace: requiredNamespace(input), ...listOptions(input) }, options(signal)))),
    listHpas: (namespace, signal) => withTimeout(signal, async (requestSignal) => page(await autoscaling.listNamespacedHorizontalPodAutoscaler({ namespace, limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)))),
    listPdbs: (namespace, signal) => withTimeout(signal, async (requestSignal) => page(await policy.listNamespacedPodDisruptionBudget({ namespace, limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)))),
    listNetworkPolicies: (namespace, signal) => withTimeout(signal, async (requestSignal) => page(await networking.listNamespacedNetworkPolicy({ namespace, limit: 200, timeoutSeconds: 10, watch: false }, options(requestSignal)))),
    getPodLogs: (input, signal) => withTimeout(signal, (requestSignal) => core.readNamespacedPodLog({ ...input, follow: false, insecureSkipTLSVerifyBackend: false }, options(requestSignal))),
  };
}

function createKubeConfig(config: KubernetesPluginConfig): KubeConfig {
  const kubeconfig = new KubeConfig();
  kubeconfig.loadFromFile(config.kubeconfigPath);
  if (kubeconfig.getContextObject(config.context) === null) {
    throw new Error(`KUBERNETES_CONTEXT does not exist in kubeconfig: ${config.context}`);
  }
  kubeconfig.setCurrentContext(config.context);
  return kubeconfig;
}

function requiredNamespace(options: KubernetesListOptions): string {
  if (!options.namespace) throw new Error("namespace is required when allNamespaces is false");
  return options.namespace;
}

class ReadOnlyMiddleware implements ObservableMiddleware {
  constructor(private readonly signal?: AbortSignal) {}

  pre(context: RequestContext): Observable<RequestContext> {
    return new Observable(Promise.resolve().then(() => {
      if (context.getHttpMethod() !== "GET") {
        throw new Error(`Kubernetes read-only boundary rejected HTTP ${context.getHttpMethod()}`);
      }
      if (this.signal !== undefined) context.setSignal(this.signal);
      return context;
    }));
  }

  post(context: ResponseContext): Observable<ResponseContext> {
    return new Observable(Promise.resolve(context));
  }
}

async function withTimeout<T>(parent: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = AbortSignal.timeout(KUBERNETES_REQUEST_TIMEOUT_MS);
  const signal = parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
  return await operation(signal);
}
