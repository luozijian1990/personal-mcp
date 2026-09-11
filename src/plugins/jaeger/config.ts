import type { PluginConfigField } from "../../core/plugin.js";

export const JAEGER_CONFIG_FIELDS: readonly PluginConfigField[] = [
  { key: "JAEGER_MCP_URL", label: "Jaeger Query 地址", description: "HTTP Query 根地址，可包含反向代理前缀，不包含 /api。", type: "text", defaultValue: "", required: true, placeholder: "http://127.0.0.1:16686" },
  { key: "JAEGER_MCP_USERNAME", label: "Username", description: "可选 Basic Auth 用户名。", type: "text", defaultValue: "" },
  { key: "JAEGER_MCP_PASSWORD", label: "Password", description: "Basic Auth 密码。", type: "password", defaultValue: "", secret: true },
];
export interface JaegerPluginConfig { readonly url: string; readonly username: string; readonly password: string }
export function loadJaegerPluginConfig(env: NodeJS.ProcessEnv = process.env): JaegerPluginConfig {
  return { url: (env.JAEGER_MCP_URL ?? "").trim(), username: (env.JAEGER_MCP_USERNAME ?? "").trim(), password: env.JAEGER_MCP_PASSWORD ?? "" };
}
export function jaegerBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Jaeger URL must be a valid HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Jaeger URL must use HTTP(S) without credentials, query or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}
