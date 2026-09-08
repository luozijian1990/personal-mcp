<div align="center">

<img src="../../../public/personal-mcp-icon.png" alt="personal-mcp" width="72" />

# MySQL MCP

让 MCP 客户端浏览 MySQL 表，并执行 SQL 查询或数据变更。

[返回项目首页](../../../README.md)

</div>

MySQL MCP 将原 Python `mysql_mcp_server` 的工具、动态资源和输出行为迁移到当前 TypeScript 插件体系。它既能执行 SQL，也能把数据库表作为 MCP resources 提供给客户端。

> [!WARNING]
> `execute_sql` 接受任意 SQL，可能修改结构或数据。请使用权限最小化的专用数据库账号，不要直接连接关键生产库。

## 工具与资源

### `execute_sql`

执行客户端提供的 SQL：

- `SELECT`：返回包含列名的逗号分隔文本。
- `SHOW TABLES`：返回当前数据库的表名。
- 其他语句：执行后返回受影响行数。
- 执行失败：返回带错误标记的 MCP tool result。

输入示例：

```json
{
  "query": "SELECT id, name FROM users LIMIT 10"
}
```

### `mysql://{table}/data`

动态 resource template：

- 列出当前数据库中的表。
- 读取 `mysql://users/data` 等 URI 时，返回该表前 100 行。
- 表名只允许字母、数字、下划线和 `$`，避免把任意 SQL 注入资源 URI。

## 配置

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MYSQL_HOST` | 是 | `localhost` | MySQL 主机 |
| `MYSQL_PORT` | 是 | `3306` | MySQL 端口 |
| `MYSQL_USER` | 是 | — | 数据库用户名 |
| `MYSQL_PASSWORD` | 是 | — | 数据库密码 |
| `MYSQL_DATABASE` | 是 | — | 默认数据库 |

可以在主服务的 Web 控制台中保存并热重载配置，也可以在首次启动时使用环境变量：

```bash
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=3306 \
MYSQL_USER=mcp_reader \
MYSQL_PASSWORD=change-me \
MYSQL_DATABASE=app \
npm run dev
```

运行时配置 API 不会返回 `MYSQL_PASSWORD`，只会通过 `secretStates.MYSQL_PASSWORD.configured`
说明密码是否已经配置。通过控制台更新其他字段时，省略密码或将密码留空都会保留旧值；
填写非空密码会替换旧值。清除密码必须点击控制台中的“明确清除”，或向配置 API 发送
`{"values": {}, "clearSecrets": ["MYSQL_PASSWORD"]}`。MySQL 密码是必填项，因此清除请求会在校验阶段被拒绝，
并保留当前运行配置。

## 启动与接入

使用统一网关：

```bash
npm run dev
```

Endpoint：`http://127.0.0.1:3100/mysql/mcp`

```bash
codex mcp add mysql --url http://127.0.0.1:3100/mysql/mcp
claude mcp add --transport http mysql http://127.0.0.1:3100/mysql/mcp
```

独立运行：

```bash
npm run dev:mysql
```

独立 endpoint：`http://127.0.0.1:3103/mysql/mcp`。可通过 `PORT` 修改端口。

## 使用示例

适合只读账号的查询：

```sql
SHOW TABLES;
SELECT COUNT(*) AS total FROM users;
SELECT id, status, created_at FROM orders ORDER BY created_at DESC LIMIT 20;
```

如果确实需要写入能力，应使用单独账号并只授予必要表上的必要权限：

```sql
UPDATE jobs SET status = 'paused' WHERE id = 42;
```

## 安全边界

- 插件不会限制 SQL 类型，实际能力由 MySQL 账号权限决定。
- 每次工具或资源请求都会建立连接，并在结束或失败时关闭连接。
- 动态表资源固定使用 `LIMIT 100`，但 `execute_sql` 本身不自动添加行数限制。
- 密码保存在已被 Git 忽略的运行时配置文件中，但 SQL 和查询结果可能进入项目日志。
- 建议对可访问库表、查询耗时、返回数据量和数据库网络入口做额外限制。
