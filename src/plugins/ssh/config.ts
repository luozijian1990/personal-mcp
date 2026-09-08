import os from "node:os";
import path from "node:path";

import type { PluginConfigField } from "../../core/plugin.js";

export const SSH_CONFIG_FIELDS: readonly PluginConfigField[] = [
  {
    key: "SSH_MCP_ALLOWED_TARGETS",
    label: "允许连接的主机",
    description: "用逗号分隔 hostname 或 IP 地址。用户名和端口在下面单独配置。",
    type: "text",
    defaultValue: "",
    required: true,
    placeholder: "server-a.example.com,10.0.0.8",
    group: { id: "connection", label: "连接" },
  },
  {
    key: "SSH_MCP_USERNAME",
    label: "SSH 用户名",
    description: "连接所有白名单主机时使用的 SSH 用户名。",
    type: "text",
    defaultValue: "",
    required: true,
    group: { id: "connection", label: "连接" },
  },
  {
    key: "SSH_MCP_PORTS",
    label: "SSH 端口",
    description: "用逗号分隔端口，连接时从左到右依次尝试，例如 22,2222,2200。",
    type: "text",
    defaultValue: "",
    required: true,
    placeholder: "22,2222",
    group: { id: "connection", label: "连接" },
  },
  {
    key: "SSH_MCP_ALLOW_COMMANDS",
    label: "允许执行远程命令",
    description: "开启后可以执行可能修改远端状态的命令，默认关闭。",
    type: "boolean",
    defaultValue: false,
    dangerous: true,
    group: { id: "safety", label: "安全边界" },
  },
  {
    key: "SSH_MCP_PRIVATE_KEY_PATH",
    label: "私钥路径",
    description: "SSH 私钥的本地路径，只保存路径，不上传或复制私钥内容。",
    type: "path",
    defaultValue: "",
    required: true,
    placeholder: "~/.ssh/id_ed25519",
    group: { id: "credentials", label: "凭据文件" },
  },
  {
    key: "SSH_MCP_KNOWN_HOSTS_PATH",
    label: "known_hosts 路径",
    description: "用于校验远端主机指纹；每个白名单主机至少要匹配一个候选端口。",
    type: "path",
    defaultValue: "",
    required: true,
    placeholder: "~/.ssh/known_hosts",
    group: { id: "credentials", label: "凭据文件" },
  },
];

export interface SshPluginConfig {
  readonly allowedTargets: ReadonlySet<string>;
  readonly allowCommands: boolean;
  readonly username?: string;
  readonly ports: readonly number[];
  /** Optional so callers can inject a config without filesystem paths in tests. */
  readonly privateKeyPath?: string;
  readonly knownHostsPath?: string;
}

export function loadSshPluginConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SshPluginConfig {
  const privateKeyPath = readConfiguredPath(environment.SSH_MCP_PRIVATE_KEY_PATH);
  const knownHostsPath = readConfiguredPath(environment.SSH_MCP_KNOWN_HOSTS_PATH);
  const username = environment.SSH_MCP_USERNAME?.trim();
  return {
    allowedTargets: new Set(
      (environment.SSH_MCP_ALLOWED_TARGETS ?? "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean),
    ),
    allowCommands: environment.SSH_MCP_ALLOW_COMMANDS === "true",
    ports: parsePorts(environment.SSH_MCP_PORTS),
    ...(username === undefined || username.length === 0 ? {} : { username }),
    ...(privateKeyPath === undefined ? {} : { privateKeyPath }),
    ...(knownHostsPath === undefined ? {} : { knownHostsPath }),
  };
}

function parsePorts(value: string | undefined): readonly number[] {
  if (value === undefined) return [];
  const ports: number[] = [];
  for (const item of value.split(",")) {
    const port = Number(item.trim());
    if (Number.isInteger(port) && port >= 1 && port <= 65_535 && !ports.includes(port)) {
      ports.push(port);
    }
  }
  return ports;
}

function readConfiguredPath(value: string | undefined): string | undefined {
  const configured = value?.trim();
  return configured === undefined || configured.length === 0
    ? undefined
    : expandHomePath(configured);
}

function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
