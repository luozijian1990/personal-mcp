import type { PluginConfigField } from "../../core/plugin.js";
export const JENKINS_CONFIG_FIELDS: readonly PluginConfigField[] = [
  { key: "JENKINS_URL", label: "Jenkins URL", description: "Jenkins 地址。", type: "text", defaultValue: "", required: true },
  { key: "JENKINS_USER", label: "用户名", description: "只读账号用户名。", type: "text", defaultValue: "", required: true },
  { key: "JENKINS_TOKEN", label: "API Token", description: "Jenkins API Token。", type: "password", defaultValue: "", required: true, secret: true },
];
export interface JenkinsPluginConfig { readonly url: string; readonly user: string; readonly token: string; }
export function loadJenkinsPluginConfig(env: NodeJS.ProcessEnv = process.env): JenkinsPluginConfig { return { url: (env.JENKINS_URL ?? "").trim().replace(/\/$/, ""), user: (env.JENKINS_USER ?? "").trim(), token: env.JENKINS_TOKEN ?? "" }; }
