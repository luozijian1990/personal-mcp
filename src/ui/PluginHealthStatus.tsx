import type { PluginHealth, PluginHealthState } from "../core/plugin.js";

type HealthLabelVariant = "secondary" | "attention" | "success" | "danger";

export interface PluginHealthPresentation {
  readonly label: string;
  readonly variant: HealthLabelVariant;
}

const HEALTH_PRESENTATIONS: Readonly<Record<PluginHealthState, PluginHealthPresentation>> = {
  unknown: { label: "状态未知", variant: "secondary" },
  unconfigured: { label: "未配置", variant: "attention" },
  healthy: { label: "健康", variant: "success" },
  degraded: { label: "性能下降", variant: "attention" },
  unhealthy: { label: "不健康", variant: "danger" },
};

export function pluginHealthPresentation(state: PluginHealthState): PluginHealthPresentation {
  return HEALTH_PRESENTATIONS[state];
}

export function PluginHealthBadge({ health }: { readonly health: PluginHealth }) {
  const presentation = pluginHealthPresentation(health.state);
  return (
    <span
      className={`metadata-label metadata-label-${presentation.variant}`}
      data-health-state={health.state}
    >
      {presentation.label}
    </span>
  );
}

export function PluginHealthDetails({ health }: { readonly health: PluginHealth }) {
  return (
    <div className="plugin-health-details" data-health-state={health.state}>
      <div className="plugin-health-title">
        <span>后端健康</span>
        <PluginHealthBadge health={health} />
      </div>
      {health.message !== undefined && <p>{health.message}</p>}
      {(health.latencyMs !== undefined || health.checkedAt !== undefined) && (
        <p className="plugin-health-meta">
          {health.latencyMs !== undefined && <span>延迟 {formatLatency(health.latencyMs)}</span>}
          {health.checkedAt !== undefined && <span>{formatCheckedAt(health.checkedAt)} 检查</span>}
        </p>
      )}
    </div>
  );
}

function formatLatency(value: number): string {
  return `${Math.round(value * 100) / 100} ms`;
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
