import type { PluginConfigField } from "../../core/plugin.js";

export const SKYWALKING_CONFIG_FIELDS: readonly PluginConfigField[] = [
  { key: "SKYWALKING_MCP_URL", label: "SkyWalking OAP 地址", description: "主机地址，自动补全 /graphql。", type: "text", defaultValue: "", required: true, placeholder: "http://127.0.0.1:12800" },
  { key: "SKYWALKING_MCP_USERNAME", label: "Username", description: "Basic Auth 用户名，可留空。", type: "text", defaultValue: "" },
  { key: "SKYWALKING_MCP_PASSWORD", label: "Password", description: "Basic Auth 密码。", type: "password", defaultValue: "", secret: true },
];
export interface SkyWalkingPluginConfig { readonly url: string; readonly username: string; readonly password: string }
export function loadSkyWalkingPluginConfig(env: NodeJS.ProcessEnv = process.env): SkyWalkingPluginConfig {
  return { url: (env.SKYWALKING_MCP_URL ?? env.SKYWALKING_URL ?? "").trim(), username: (env.SKYWALKING_MCP_USERNAME ?? "").trim(), password: env.SKYWALKING_MCP_PASSWORD ?? "" };
}
export function graphqlUrl(value: string): string { const u = new URL(value); if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("SkyWalking URL must use http or https"); if (u.pathname === "/" || u.pathname === "") u.pathname = "/graphql"; else if (!u.pathname.endsWith("/graphql")) u.pathname = `${u.pathname.replace(/\/$/, "")}/graphql`; if (u.search || u.hash || u.username || u.password) throw new Error("SkyWalking URL must not contain credentials, query, or fragment"); return u.toString(); }
