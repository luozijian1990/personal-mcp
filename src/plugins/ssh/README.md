<div align="center">

<img src="../../../public/personal-mcp-icon.png" alt="personal-mcp" width="72" />

# SSH MCP

通过受控 SSH 连接获取远程主机状态，并在明确授权后执行命令。

[返回项目首页](../../../README.md)

</div>

SSH MCP 适合让 MCP 客户端诊断 Linux/Unix 主机：服务只连接白名单目标，使用指定私钥认证，并强制校验 `known_hosts` 中的主机指纹。

> [!WARNING]
> `ssh_execute_command` 能够修改或删除远程数据。该工具默认关闭，不能替代操作者对具体目标和命令的授权。

## 工具

| 工具 | 用途 | 风险 |
| --- | --- | --- |
| `ssh_get_system_snapshot` | 获取身份、主机名、时间、内核、运行时间和磁盘空间 | 只读 |
| `ssh_execute_command` | 在一台白名单主机上执行一条 shell 命令 | 可修改远端状态 |

两个工具都接受：

- `target`：`SSH_MCP_ALLOWED_TARGETS` 中的精确主机名或 IP 地址。
- `timeoutSeconds`：执行超时，5–300 秒，默认 30。
- `maxOutputCharacters`：返回的 stdout/stderr 字符上限，1,000–100,000，默认 20,000。

返回结果包含实际端口、已尝试端口、退出码、耗时、stdout、stderr，以及输出是否被截断。

## 配置

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SSH_MCP_ALLOWED_TARGETS` | 是 | 允许连接的主机名或 IP，多个值用逗号分隔 |
| `SSH_MCP_USERNAME` | 是 | 所有目标共用的 SSH 用户名 |
| `SSH_MCP_PORTS` | 是 | 按顺序尝试的端口，如 `22,2222` |
| `SSH_MCP_PRIVATE_KEY_PATH` | 是 | 本机 SSH 私钥路径，支持 `~/` |
| `SSH_MCP_KNOWN_HOSTS_PATH` | 是 | 用于校验目标指纹的 `known_hosts` 路径 |
| `SSH_MCP_ALLOW_COMMANDS` | 否 | 是否开放任意命令，默认 `false` |

可以在主服务的 Web 控制台中保存并热重载配置，也可以在首次启动时使用环境变量：

```bash
SSH_MCP_ALLOWED_TARGETS=server.example.com \
SSH_MCP_USERNAME=ops-user \
SSH_MCP_PORTS=22,2222 \
SSH_MCP_PRIVATE_KEY_PATH=~/.ssh/ops_key \
SSH_MCP_KNOWN_HOSTS_PATH=~/.ssh/known_hosts \
npm run dev
```

配置保存前会检查字段、私钥格式，以及每个目标是否能在至少一个候选端口上匹配主机指纹。校验失败时，当前运行中的插件不会被替换。

## 创建远端专用运维用户

建议不要让 MCP 使用 `root`、个人账号或与其他自动化共享的账号。应在每台白名单主机上创建一个非 root 专用用户，例如 `agent-ops`，并只授予完成目标任务所需的权限。

> [!IMPORTANT]
> 一个 SSH MCP 实例的所有目标共用 `SSH_MCP_USERNAME`。如果不同主机必须使用不同账号，请运行相互独立的 MCP 实例并分别配置端口、目标和凭据。

### 1. 生成独立密钥

在运行 MCP 的主机上生成仅供该实例使用的 Ed25519 密钥。当前插件没有私钥口令配置项，因此自动运行所用私钥必须依靠本机文件权限和主机访问控制保护，不要把它复制到源码、Skill 目录、容器镜像或配置仓库中。

```bash
ssh-keygen -t ed25519 -C "personal-mcp-agent-ops" \
  -f ~/.ssh/personal_mcp_agent_ops -N ""
chmod 600 ~/.ssh/personal_mcp_agent_ops
```

MCP 只需要读取私钥；远端服务器只部署对应的 `.pub` 公钥。

### 2. 创建非 root 用户并部署公钥

以下命令以常见 Linux 发行版为例；用户和主组的创建方式应按目标系统调整：

```bash
sudo useradd -m -s /bin/bash agent-ops
sudo passwd -l agent-ops
sudo install -d -m 0700 -o agent-ops -g agent-ops /home/agent-ops/.ssh
sudo install -m 0600 -o agent-ops -g agent-ops \
  ./personal_mcp_agent_ops.pub /home/agent-ops/.ssh/authorized_keys
```

建议在 `authorized_keys` 中为该公钥增加限制，禁止端口转发、Agent 转发、X11 和 PTY：

```text
restrict ssh-ed25519 AAAA... personal-mcp-agent-ops
```

如果 MCP 主机具有稳定出口地址，还可以叠加 `from="<MCP_HOST_IP>"`。修改前应确认 NAT、跳板机和故障切换路径，避免把合法连接锁死。`restrict` 不会限制远端 shell 可以执行哪些命令；命令权限仍由该用户的 Unix 权限和 sudoers 决定。

### 3. 固定并核验主机指纹

为每个允许的目标和候选端口准备独立的 `known_hosts` 文件。`ssh-keyscan` 只能收集公钥，不能证明公钥属于目标主机；首次写入前必须通过控制台、资产平台或其他可信渠道核对指纹。

```bash
ssh-keyscan -p 22 server.example.com > ~/.ssh/personal_mcp_known_hosts
ssh-keygen -lf ~/.ssh/personal_mcp_known_hosts
chmod 600 ~/.ssh/personal_mcp_known_hosts
```

非标准端口会以 `[host]:port` 的形式记录。轮换服务器主机密钥时，应先核实新指纹，再更新文件；不要通过关闭 host-key checking 绕过错误。

### 4. 按能力分级授权

推荐从最低权限开始：

| 等级 | MCP 配置 | 远端权限 |
| --- | --- | --- |
| 系统快照 | `SSH_MCP_ALLOW_COMMANDS=false` | 普通用户即可；只执行固定的身份、时间、内核、运行时间和磁盘查询 |
| 只读诊断 | 谨慎开启任意命令 | 优先使用用户组、文件 ACL 和服务自带的只读接口，不授予 sudo |
| 受控处置 | 谨慎开启任意命令 | 只允许调用少量 root-owned 固定脚本，并由 sudoers 精确授权 |

`SSH_MCP_ALLOW_COMMANDS=true` 会允许 MCP 把任意 shell 字符串交给远端账号执行；它不是命令白名单。`acknowledgeRemoteChangeRisk: true` 也只是调用者对风险的显式确认，不会增加或限制远端权限。真正的硬授权边界始终是远端账号、文件权限和 sudoers。

### 5. 必须使用 sudo 时

不要直接复制宽泛的 sudoers 规则，例如 `journalctl *`、`systemctl *`、`kubectl exec *`、`less` 或带任意参数的 `cat`。通配参数、pager、shell escape、容器执行以及 root kubeconfig 都可能把看似只读的授权扩大为任意命令执行或敏感数据读取。

更安全的做法是创建用途单一的 root-owned 包装脚本：脚本拒绝额外参数，使用绝对命令路径，不调用 `eval`，不接受任意文件名，并只输出完成任务所需的信息。sudoers 再精确允许这些入口：

```sudoers
# 使用 visudo -f /etc/sudoers.d/agent-ops 编辑并校验
agent-ops ALL=(root) NOPASSWD: /usr/local/sbin/agent-check-nginx
agent-ops ALL=(root) NOPASSWD: /usr/local/sbin/agent-restart-nginx
```

包装脚本应由 `root:root` 拥有且不可由 `agent-ops` 修改。部署后同时验证允许路径和拒绝路径：

```bash
sudo visudo -c
sudo -l -U agent-ops
sudo -u agent-ops sudo /usr/local/sbin/agent-check-nginx
sudo -u agent-ops sudo /bin/sh  # 必须被拒绝
```

完成远端授权后，将专用用户名、目标、私钥和已核验的 `known_hosts` 路径写入 SSH MCP 配置，再先调用 `ssh_get_system_snapshot` 验证身份与连接。只有确实需要远端命令时，才开启 `SSH_MCP_ALLOW_COMMANDS`。

## 启动与接入

使用统一网关：

```bash
npm run dev
```

Endpoint：`http://127.0.0.1:3100/ssh/mcp`

```bash
codex mcp add ssh --url http://127.0.0.1:3100/ssh/mcp
claude mcp add --transport http ssh http://127.0.0.1:3100/ssh/mcp
```

独立运行：

```bash
npm run dev:ssh
```

独立 endpoint：`http://127.0.0.1:3101/ssh/mcp`。可通过 `PORT` 修改端口。

## 调用示例

获取系统快照：

```json
{
  "target": "server.example.com",
  "timeoutSeconds": 30,
  "maxOutputCharacters": 20000
}
```

执行命令前，需要将 `SSH_MCP_ALLOW_COMMANDS` 设为 `true`，并在每次调用中显式确认风险：

```json
{
  "target": "server.example.com",
  "command": "systemctl status nginx --no-pager",
  "timeoutSeconds": 30,
  "maxOutputCharacters": 20000,
  "acknowledgeRemoteChangeRisk": true
}
```

## 安全边界

- 服务不会传递 SSH 密码，也不会自动接受未知主机指纹。
- 目标必须与白名单中的值精确匹配。
- 候选端口只在建立连接前依次尝试；连接成功后，命令只执行一次。
- 私钥内容不会写入运行时配置，但私钥路径属于本机敏感信息。
- MCP 请求和响应可能进入项目日志，请避免在命令中直接携带凭据。
