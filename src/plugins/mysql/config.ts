import type { PluginConfigField } from "../../core/plugin.js";

export const MYSQL_CONFIG_FIELDS: readonly PluginConfigField[] = [
  { key: "MYSQL_HOST", label: "MySQL Host", description: "数据库主机。", type: "text", defaultValue: "localhost", required: true },
  { key: "MYSQL_PORT", label: "MySQL Port", description: "数据库端口。", type: "text", defaultValue: "3306", required: true },
  { key: "MYSQL_USER", label: "MySQL User", description: "数据库用户名。", type: "text", defaultValue: "", required: true },
  { key: "MYSQL_PASSWORD", label: "MySQL Password", description: "数据库密码。", type: "text", defaultValue: "", required: true, dangerous: true },
  { key: "MYSQL_DATABASE", label: "MySQL Database", description: "默认数据库名。", type: "text", defaultValue: "", required: true },
];

export interface MysqlPluginConfig { readonly host: string; readonly port: number; readonly user: string; readonly password: string; readonly database: string; }

export function loadMysqlPluginConfig(env: NodeJS.ProcessEnv = process.env): MysqlPluginConfig {
  const port = Number(env.MYSQL_PORT ?? "3306");
  return { host: env.MYSQL_HOST?.trim() || "localhost", port, user: env.MYSQL_USER?.trim() || "", password: env.MYSQL_PASSWORD ?? "", database: env.MYSQL_DATABASE?.trim() || "" };
}

export function validateMysqlConfig(config: MysqlPluginConfig): void {
  if (!config.user || !config.password || !config.database) throw new Error("Missing required database configuration: MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE are required");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("MYSQL_PORT must be a valid port");
}
