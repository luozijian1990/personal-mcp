import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { createConnection, type Connection } from "mysql2/promise";
import type { PersonalMcpPlugin, PersonalMcpPluginMetadata } from "../../core/plugin.js";
import { toolErrorResult, toolTextResult } from "../../core/tool-result.js";
import { loadMysqlPluginConfig, MYSQL_CONFIG_FIELDS, validateMysqlConfig, type MysqlPluginConfig } from "./config.js";

export interface MysqlExecutor { (config: MysqlPluginConfig, query: string): Promise<string>; }

export const MYSQL_PLUGIN_METADATA: PersonalMcpPluginMetadata = {
  id: "mysql",
  displayName: "MySQL Database",
  summary: "浏览 MySQL 表并执行 SQL 查询。",
  category: { id: "databases", name: "数据库", description: "查询和分析数据库数据。" },
};

export function createMysqlPlugin(options: { config?: MysqlPluginConfig; executor?: MysqlExecutor } = {}): PersonalMcpPlugin {
  const config = options.config ?? loadMysqlPluginConfig();
  const executor = options.executor ?? executeMysql;
  return { ...MYSQL_PLUGIN_METADATA, tools: [{ name: "execute_sql", title: "执行 SQL", risk: "privileged", requiresConfirmation: true, logging: { input: "redacted", output: "none" } }], config: { fields: MYSQL_CONFIG_FIELDS }, checkHealth: async () => { validateMysqlConfig(config); const conn = await createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database }); try { await conn.query("SELECT 1"); return { state: "healthy", message: "MySQL connection is healthy" }; } finally { await conn.end(); } }, createServer: () => createMysqlServer(config, executor) };
}

function createMysqlServer(config: MysqlPluginConfig, executor: MysqlExecutor): McpServer {
  const server = new McpServer({ name: "mysql_mcp_server", version: "0.1.0" });
  server.registerTool("execute_sql", { title: "Execute an SQL query on MySQL", description: "Execute an SQL query on the configured MySQL server. SELECT and SHOW TABLES results are returned as CSV-like text; other statements are committed and report affected rows.", inputSchema: z.object({ query: z.string().min(1).describe("The SQL query to execute") }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, async ({ query }) => {
    try { return toolTextResult(await executor(config, query)); }
    catch (error) { return toolErrorResult(error, { prefix: "Error executing query: " }); }
  });
  server.registerResource("mysql-tables", new ResourceTemplate("mysql://{table}/data", {
    list: async () => {
      try {
        const tables = await listTables(config);
        return { resources: tables.map((table) => ({ uri: `mysql://${table}/data`, name: `Table: ${table}`, mimeType: "text/plain", description: `Data in table: ${table}` })) };
      } catch { return { resources: [] }; }
    },
  }), { title: "MySQL tables", description: "Tables in the configured MySQL database", mimeType: "text/plain" }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: await readTable(config, String(variables.table)) }] }));
  return server;
}

async function listTables(config: MysqlPluginConfig): Promise<string[]> {
  validateMysqlConfig(config);
  const conn = await createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
  try { const [rows] = await conn.query("SHOW TABLES"); return (rows as Array<Record<string, unknown>>).map((row) => String(Object.values(row)[0])); } finally { await conn.end(); }
}

async function readTable(config: MysqlPluginConfig, table: string): Promise<string> {
  if (!/^[A-Za-z0-9_$]+$/.test(table)) throw new Error("Invalid table name");
  validateMysqlConfig(config);
  const conn = await createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
  try { const [rows, fields] = await conn.query(`SELECT * FROM \`${table}\` LIMIT 100`); return [fields.map((f) => f.name).join(","), ...(rows as unknown[][]).map((row) => row.map(String).join(","))].join("\n"); } finally { await conn.end(); }
}

async function executeMysql(config: MysqlPluginConfig, query: string): Promise<string> {
  validateMysqlConfig(config);
  const conn: Connection = await createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
  try { const [rows, fields] = await conn.query(query); const upper = query.trim().toUpperCase(); if (upper.startsWith("SHOW TABLES")) return ["Tables_in_" + config.database, ...(rows as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0]))].join("\n"); if (upper.startsWith("SELECT")) { const header = fields.map((f) => f.name).join(","); return [header, ...(rows as unknown[][]).map((row) => row.map(String).join(","))].join("\n"); } return `Query executed successfully. Rows affected: ${(rows as { affectedRows?: number }).affectedRows ?? 0}`; } finally { await conn.end(); }
}
