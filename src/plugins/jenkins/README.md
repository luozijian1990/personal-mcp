# Jenkins MCP

只读查询 Jenkins Job、构建详情和 Console Log。配置 `JENKINS_URL`、`JENKINS_USER`、`JENKINS_TOKEN`，使用 API Token 认证。Console Log 默认保留最后 100,000 个字符，并提取包含 error、exception、failed、failure 的行作为失败提示。
