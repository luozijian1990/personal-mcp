import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  AlertIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CodeSquareIcon,
  CopyIcon,
  HomeIcon,
  GearIcon,
  KeyIcon,
  ListUnorderedIcon,
  PackageIcon,
  PlugIcon,
  ServerIcon,
  SyncIcon,
  TerminalIcon,
  ToolsIcon,
} from "@primer/octicons-react";
import {
  Button,
  Flash,
  FormControl,
  Heading,
  IconButton,
  Label,
  Spinner,
  Text,
  TextInput,
  Tooltip,
  ToggleSwitch,
} from "@primer/react";

interface ToolStatus {
  readonly name: string;
  readonly title: string;
  readonly risk: "read-only" | "write-capable";
}

interface CategoryStatus {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

interface PluginStatus {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly category: CategoryStatus;
  readonly path: string;
  readonly tools: readonly ToolStatus[];
  readonly configurable: boolean;
}

type PluginConfigValue = string | boolean;

interface PluginConfigField {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly type: "text" | "boolean";
  readonly defaultValue: PluginConfigValue;
  readonly required?: boolean;
  readonly dangerous?: boolean;
}

interface PluginConfigSnapshot {
  readonly pluginId: string;
  readonly fields: readonly PluginConfigField[];
  readonly values: Readonly<Record<string, PluginConfigValue>>;
  readonly revision: number;
  readonly updatedAt: string | null;
}

interface ServiceStatus {
  readonly service: string;
  readonly status: "online";
  readonly auth: "none";
  readonly bind: string;
  readonly transport: string;
  readonly endpoints: readonly PluginStatus[];
}

interface CategoryGroup extends CategoryStatus {
  readonly plugins: readonly PluginStatus[];
}

type Route =
  | { readonly page: "home" }
  | { readonly page: "catalog"; readonly categoryId?: string }
  | { readonly page: "detail"; readonly pluginId: string };

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: ServiceStatus; readonly checkedAt: Date }
  | { readonly kind: "error"; readonly message: string };

type ClientTab = "codex" | "claude";

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [route, setRoute] = useState<Route>(() => readRoute());
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/status", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as ServiceStatus;
      setState({ kind: "ready", data, checkedAt: new Date() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setState({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleRoute = () => setRoute(readRoute());
    window.addEventListener("hashchange", handleRoute);
    return () => window.removeEventListener("hashchange", handleRoute);
  }, []);

  const navigate = (next: Route) => {
    window.location.hash = serializeRoute(next);
    setRoute(next);
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(value);
    window.setTimeout(() => setCopied(null), 1_600);
  };

  return (
    <div className="app-shell">
      <IconNavigation route={route} navigate={navigate} />
      <main className="main-content">
        <Topbar state={state} route={route} refresh={refresh} />
        {state.kind === "loading" && <LoadingState />}
        {state.kind === "error" && <ErrorState message={state.message} retry={refresh} />}
        {state.kind === "ready" && (
          <RouteContent
            data={state.data}
            route={route}
            navigate={navigate}
            copied={copied}
            copy={copy}
          />
        )}
      </main>
    </div>
  );
}

function IconNavigation({ route, navigate }: {
  readonly route: Route;
  readonly navigate: (route: Route) => void;
}) {
  return (
    <aside className="icon-sidebar" aria-label="主导航">
      <div className="brand-mark" aria-label="Personal MCP"><PlugIcon size={20} /></div>
      <nav className="icon-nav" aria-label="控制台页面">
        <Tooltip text="首页" direction="e">
          <IconButton
            className={route.page === "home" ? "nav-icon active" : "nav-icon"}
            aria-label="首页"
            icon={HomeIcon}
            variant="invisible"
            onClick={() => navigate({ page: "home" })}
          />
        </Tooltip>
        <Tooltip text="MCP 明细" direction="e">
          <IconButton
            className={route.page !== "home" ? "nav-icon active" : "nav-icon"}
            aria-label="MCP 明细"
            icon={ListUnorderedIcon}
            variant="invisible"
            onClick={() => navigate({ page: "catalog" })}
          />
        </Tooltip>
      </nav>
      <div className="nav-security" aria-label="当前未启用认证"><KeyIcon size={17} /></div>
    </aside>
  );
}

function Topbar({ state, route, refresh }: {
  readonly state: LoadState;
  readonly route: Route;
  readonly refresh: () => Promise<void>;
}) {
  const title = route.page === "home" ? "首页" : route.page === "catalog" ? "MCP 明细" : "MCP 接入";
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div>
          <Text as="p" className="product-name">{title}</Text>
          <Text as="p" className="product-context">Personal MCP Console</Text>
        </div>
        <div className="topbar-actions">
          {state.kind === "ready" && (
            <Text as="span" className="checked-time">
              {state.checkedAt.toLocaleTimeString("zh-CN", { hour12: false })} 检查
            </Text>
          )}
          <Tooltip text="刷新服务状态">
            <IconButton aria-label="刷新服务状态" icon={SyncIcon} variant="invisible" onClick={() => void refresh()} />
          </Tooltip>
        </div>
      </div>
    </header>
  );
}

function RouteContent({ data, route, navigate, copied, copy }: {
  readonly data: ServiceStatus;
  readonly route: Route;
  readonly navigate: (route: Route) => void;
  readonly copied: string | null;
  readonly copy: (value: string) => Promise<void>;
}) {
  if (route.page === "home") return <HomePage data={data} navigate={navigate} />;
  if (route.page === "catalog") {
    return <CatalogPage data={data} categoryId={route.categoryId} navigate={navigate} />;
  }
  const plugin = data.endpoints.find((item) => item.id === route.pluginId);
  if (plugin === undefined) return <NotFoundPage navigate={navigate} />;
  return <PluginDetail plugin={plugin} data={data} copied={copied} copy={copy} navigate={navigate} />;
}

function HomePage({ data, navigate }: {
  readonly data: ServiceStatus;
  readonly navigate: (route: Route) => void;
}) {
  const categories = useMemo(() => groupCategories(data.endpoints), [data.endpoints]);
  return (
    <div className="page-wrap home-page">
      <section className="page-heading">
        <div className="live-status"><CheckCircleIcon size={16} /> 主服务运行中</div>
        <Heading as="h1">MCP 分类</Heading>
        <Text as="p">从能力领域开始，找到你需要的个人工具，再选择合适的客户端接入。</Text>
      </section>

      <section className="category-list" aria-label="MCP 分类">
        {categories.length === 0 ? <EmptyState /> : categories.map((category) => (
          <button
            className="category-row"
            key={category.id}
            onClick={() => navigate({ page: "catalog", categoryId: category.id })}
          >
            <span className="category-icon"><TerminalIcon size={24} /></span>
            <span className="category-copy"><strong>{category.name}</strong><span>{category.description}</span></span>
            <span className="category-count"><strong>{category.plugins.length}</strong><span>个 MCP</span></span>
            <ChevronRightIcon size={20} />
          </button>
        ))}
      </section>

      <section className="home-service-strip" aria-label="主服务信息">
        <ServiceFact icon={ServerIcon} label="传输" value={data.transport} />
        <ServiceFact icon={PlugIcon} label="已加载" value={`${data.endpoints.length} 个 MCP`} />
        <ServiceFact icon={KeyIcon} label="认证" value="暂未启用" warning />
      </section>

      <section className="home-intro" aria-labelledby="home-intro-title">
        <div className="home-intro-copy">
          <Heading as="h2" id="home-intro-title">一个入口，连接你的个人工具</Heading>
          <Text as="p">
            平时通过主服务统一接入各个 MCP，客户端只需要使用固定地址。需要单独使用某个 MCP 时，也可以直接连接它。
          </Text>
        </div>
        <div className="home-principles">
          <article>
            <PackageIcon size={20} />
            <div><strong>按领域组织</strong><p>分类只回答“它能做什么”，具体能力留在明细页查看。</p></div>
          </article>
          <article>
            <PlugIcon size={20} />
            <div><strong>统一接入</strong><p>从详情页复制完整命令，把 MCP 添加到常用客户端。</p></div>
          </article>
          <article>
            <CodeSquareIcon size={20} />
            <div><strong>保持独立</strong><p>子 MCP 不依赖主服务，也可以使用自己的端口单独启动。</p></div>
          </article>
        </div>
      </section>
    </div>
  );
}

function CatalogPage({ data, categoryId, navigate }: {
  readonly data: ServiceStatus;
  readonly categoryId?: string;
  readonly navigate: (route: Route) => void;
}) {
  const categories = groupCategories(data.endpoints);
  const visiblePlugins = categoryId === undefined
    ? data.endpoints
    : data.endpoints.filter((plugin) => plugin.category.id === categoryId);
  return (
    <div className="page-wrap catalog-page">
      <section className="page-heading compact">
        <Heading as="h1">MCP 明细</Heading>
        <Text as="p">查看服务端点、能力范围和接入方式。</Text>
      </section>

      <div className="category-tabs" role="tablist" aria-label="MCP 分类筛选">
        <button role="tab" aria-selected={categoryId === undefined} className={categoryId === undefined ? "active" : ""} onClick={() => navigate({ page: "catalog" })}>
          全部 <span>{data.endpoints.length}</span>
        </button>
        {categories.map((category) => (
          <button role="tab" aria-selected={categoryId === category.id} className={categoryId === category.id ? "active" : ""} key={category.id} onClick={() => navigate({ page: "catalog", categoryId: category.id })}>
            {category.name} <span>{category.plugins.length}</span>
          </button>
        ))}
      </div>

      <section className="mcp-list" aria-label="MCP 列表">
        {visiblePlugins.map((plugin) => (
          <button className="mcp-row" key={plugin.id} onClick={() => navigate({ page: "detail", pluginId: plugin.id })}>
            <span className="plugin-icon"><TerminalIcon size={22} /></span>
            <span className="mcp-row-main">
              <span className="mcp-row-title"><strong>{plugin.name}</strong><Label variant="success">运行中</Label></span>
              <span>{plugin.summary}</span>
            </span>
            <span className="mcp-meta"><span>{plugin.tools.length} 个工具</span><code>{plugin.path}</code></span>
            <ChevronRightIcon size={20} />
          </button>
        ))}
      </section>
    </div>
  );
}

function PluginDetail({ plugin, data, copied, copy, navigate }: {
  readonly plugin: PluginStatus;
  readonly data: ServiceStatus;
  readonly copied: string | null;
  readonly copy: (value: string) => Promise<void>;
  readonly navigate: (route: Route) => void;
}) {
  const [clientTab, setClientTab] = useState<ClientTab>("codex");
  const endpoint = `${window.location.origin}${plugin.path}`;
  const commands: Record<ClientTab, { label: string; command: string; note: string }> = {
    codex: {
      label: "Codex",
      command: `codex mcp add ${plugin.id} --url ${endpoint}`,
      note: "添加为 Streamable HTTP MCP 服务。",
    },
    claude: {
      label: "Claude Code",
      command: `claude mcp add --transport http ${plugin.id} ${endpoint}`,
      note: "默认添加到当前项目作用域。",
    },
  };
  const selected = commands[clientTab];

  return (
    <div className="page-wrap detail-page">
      <Button className="back-button" variant="invisible" leadingVisual={ArrowLeftIcon} onClick={() => navigate({ page: "catalog", categoryId: plugin.category.id })}>
        返回 MCP 明细
      </Button>

      <section className="detail-heading">
        <div className="plugin-icon large"><TerminalIcon size={28} /></div>
        <div>
          <div className="detail-title-line"><Heading as="h1">{plugin.name}</Heading><Label variant="success">运行中</Label></div>
          <Text as="p">{plugin.summary}</Text>
        </div>
      </section>

      <div className="detail-layout">
        <section className="install-section">
          <Heading as="h2">添加到客户端</Heading>
          <Text as="p" className="section-description">选择客户端并复制完整命令。</Text>

          <div className="client-tabs" role="tablist" aria-label="选择 MCP 客户端">
            {(Object.keys(commands) as ClientTab[]).map((client) => (
              <button key={client} role="tab" aria-selected={clientTab === client} className={clientTab === client ? "active" : ""} onClick={() => setClientTab(client)}>
                {commands[client].label}
              </button>
            ))}
          </div>

          <div className="command-panel">
            <div className="command-label"><CodeSquareIcon size={16} /> 终端命令</div>
            <pre><code>{selected.command}</code></pre>
            <Button leadingVisual={copied === selected.command ? CheckCircleIcon : CopyIcon} onClick={() => void copy(selected.command)}>
              {copied === selected.command ? "已复制" : "复制命令"}
            </Button>
          </div>
          <Text as="p" className="command-note">{selected.note}</Text>

          <div className="endpoint-section">
            <div><Text as="p" className="field-label">MCP endpoint</Text><code>{endpoint}</code></div>
            <IconButton aria-label="复制 MCP endpoint" icon={copied === endpoint ? CheckCircleIcon : CopyIcon} variant="invisible" onClick={() => void copy(endpoint)} />
          </div>
        </section>

        <aside className="detail-aside">
          <Heading as="h2">服务信息</Heading>
          <ServiceFact icon={TerminalIcon} label="分类" value={plugin.category.name} />
          <ServiceFact icon={ServerIcon} label="传输" value={data.transport} />
          <ServiceFact icon={KeyIcon} label="认证" value="暂未启用" warning />
        </aside>
      </div>

      <section className="tools-section">
        <div className="section-title-line"><ToolsIcon size={18} /><Heading as="h2">可用工具</Heading></div>
        <div className="tool-list">
          {plugin.tools.map((tool) => (
            <div className="tool-row" key={tool.name}>
              <div><strong>{tool.title}</strong><code>{tool.name}</code></div>
              <Label variant={tool.risk === "read-only" ? "success" : "attention"}>{tool.risk === "read-only" ? "只读" : "可变更"}</Label>
            </div>
          ))}
        </div>
      </section>

      {plugin.configurable && <PluginConfigPanel pluginId={plugin.id} />}
    </div>
  );
}

function PluginConfigPanel({ pluginId }: { readonly pluginId: string }) {
  const [config, setConfig] = useState<PluginConfigSnapshot | null>(null);
  const [values, setValues] = useState<Record<string, PluginConfigValue>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<
    { readonly kind: "success" | "error"; readonly message: string } | null
  >(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFeedback(null);
    void fetch(`/api/config/${encodeURIComponent(pluginId)}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await readApiError(response));
      const body = await response.json() as { config: PluginConfigSnapshot };
      setConfig(body.config);
      setValues({ ...body.config.values });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setFeedback({ kind: "error", message: errorMessage(error) });
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [pluginId]);

  const saveAndReload = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/config/${encodeURIComponent(pluginId)}`, {
        method: "PUT",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const body = await response.json() as { config: PluginConfigSnapshot };
      setConfig(body.config);
      setValues({ ...body.config.values });
      setFeedback({ kind: "success", message: "配置已保存，MCP 已重新加载。" });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="config-section" aria-labelledby={`${pluginId}-config-title`}>
      <div className="config-heading">
        <div>
          <div className="section-title-line">
            <GearIcon size={18} />
            <Heading as="h2" id={`${pluginId}-config-title`}>运行配置</Heading>
          </div>
          {config?.updatedAt !== null && config?.updatedAt !== undefined && (
            <Text as="p" className="config-revision">
              版本 {config.revision} · {formatUpdatedAt(config.updatedAt)}
            </Text>
          )}
        </div>
      </div>

      {loading && <div className="config-loading"><Spinner size="small" /><span>正在读取配置</span></div>}
      {!loading && config !== null && (
        <form onSubmit={(event) => { event.preventDefault(); void saveAndReload(); }}>
          <div className="config-fields">
            {config.fields.map((field) => field.type === "boolean" ? (
              <div className="config-toggle-row" key={field.key}>
                <div id={`${pluginId}-${field.key}-label`} className="config-field-copy">
                  <div className="config-field-label">
                    <strong>{field.label}</strong>
                    {field.dangerous && <Label variant="attention">高风险</Label>}
                  </div>
                  <code>{field.key}</code>
                  <Text as="p">{field.description}</Text>
                </div>
                <ToggleSwitch
                  aria-labelledby={`${pluginId}-${field.key}-label`}
                  checked={values[field.key] === true}
                  disabled={saving}
                  onChange={(checked) => setValues((current) => ({ ...current, [field.key]: checked }))}
                  buttonLabelOn="已启用"
                  buttonLabelOff="已停用"
                />
              </div>
            ) : (
              <FormControl
                className="config-text-field"
                id={`${pluginId}-${field.key}`}
                key={field.key}
                required={field.required}
              >
                <FormControl.Label>
                  <span className="config-field-label"><strong>{field.label}</strong><code>{field.key}</code></span>
                </FormControl.Label>
                <TextInput
                  block
                  disabled={saving}
                  value={typeof values[field.key] === "string" ? values[field.key] : ""}
                  onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                />
                <FormControl.Caption>{field.description}</FormControl.Caption>
              </FormControl>
            ))}
          </div>

          {feedback !== null && (
            <Flash className="config-feedback" variant={feedback.kind === "success" ? "success" : "danger"}>
              {feedback.kind === "error" && <AlertIcon size={16} />} {feedback.message}
            </Flash>
          )}

          <div className="config-actions">
            <Button type="submit" variant="primary" leadingVisual={SyncIcon} disabled={saving}>
              {saving ? "正在保存" : "保存并重载 MCP"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

async function readApiError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Fall through to the HTTP status when the response is not JSON.
  }
  return `HTTP ${response.status}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function ServiceFact({ icon: Icon, label, value, warning = false }: {
  readonly icon: typeof ServerIcon;
  readonly label: string;
  readonly value: string;
  readonly warning?: boolean;
}) {
  return <div className="service-fact"><Icon size={17} /><div><span>{label}</span><strong className={warning ? "warning" : ""}>{value}</strong></div></div>;
}

function EmptyState() {
  return <div className="empty-state"><PackageIcon size={28} /><Heading as="h3">还没有 MCP</Heading><Text as="p">主服务加载插件后，对应分类会出现在这里。</Text></div>;
}

function NotFoundPage({ navigate }: { readonly navigate: (route: Route) => void }) {
  return <div className="center-state"><PackageIcon size={28} /><Heading as="h2">没有找到这个 MCP</Heading><Button onClick={() => navigate({ page: "catalog" })}>返回明细</Button></div>;
}

function LoadingState() {
  return <div className="center-state" aria-live="polite"><Spinner size="medium" /><Text as="p">正在读取服务状态</Text></div>;
}

function ErrorState({ message, retry }: { readonly message: string; readonly retry: () => Promise<void> }) {
  return <div className="center-state"><Flash variant="danger">无法读取主服务：{message}</Flash><Button onClick={() => void retry()}>重新连接</Button></div>;
}

function groupCategories(plugins: readonly PluginStatus[]): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();
  for (const plugin of plugins) {
    const existing = groups.get(plugin.category.id);
    groups.set(plugin.category.id, existing === undefined
      ? { ...plugin.category, plugins: [plugin] }
      : { ...existing, plugins: [...existing.plugins, plugin] });
  }
  return [...groups.values()];
}

function readRoute(): Route {
  const value = window.location.hash.replace(/^#\/?/, "");
  if (value.startsWith("mcp/")) return { page: "detail", pluginId: decodeURIComponent(value.slice(4)) };
  if (value.startsWith("catalog/")) return { page: "catalog", categoryId: decodeURIComponent(value.slice(8)) };
  if (value === "catalog") return { page: "catalog" };
  return { page: "home" };
}

function serializeRoute(route: Route): string {
  if (route.page === "detail") return `/mcp/${encodeURIComponent(route.pluginId)}`;
  if (route.page === "catalog") return route.categoryId === undefined ? "/catalog" : `/catalog/${encodeURIComponent(route.categoryId)}`;
  return "/";
}
