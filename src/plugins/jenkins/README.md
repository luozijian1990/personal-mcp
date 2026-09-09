<div align="center">

<img src="../../../public/personal-mcp-icon.png" alt="personal-mcp" width="72" />

# Jenkins MCP

只读查询 Jenkins Job、构建详情和 Console Log。

[返回项目首页](../../../README.md)

</div>

## 工具

| 工具 | 用途 | 风险 |
| --- | --- | --- |
| `jenkins_get_job` | 查询 Job 元数据和最近构建 | 只读 |
| `jenkins_get_build` | 查询指定构建详情和结果 | 只读 |
| `jenkins_get_console_log` | 查看 Console Log，并提取失败线索 | 只读 |

## 配置

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `JENKINS_URL` | 是 | Jenkins HTTP(S) 地址 |
| `JENKINS_USER` | 是 | 只读账号用户名 |
| `JENKINS_TOKEN` | 是 | API Token，按 Secret 保存 |

可通过 Web 控制台配置，也可使用环境变量启动。Console Log 最多返回最后 50,000 个字符。

## 启动与接入

```bash
npm run dev
```

网关 endpoint：`http://127.0.0.1:3100/jenkins/mcp`

独立运行：

```bash
npm run dev:jenkins
```

独立 endpoint：`http://127.0.0.1:3104/jenkins/mcp`。
