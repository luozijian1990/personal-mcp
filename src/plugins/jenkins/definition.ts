import type { PersonalMcpPluginDefinition } from "../../core/plugin.js";
import { createJenkinsConfigManager } from "./config-manager.js";
import { createJenkinsPlugin, } from "./index.js";
import { loadJenkinsPluginConfig } from "./config.js";
export const JENKINS_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = { metadata: { id: "jenkins", displayName: "Jenkins", summary: "只读查询 Jenkins Job、构建配置和 Console Log。", category: { id: "ci", name: "持续集成", description: "查询构建状态与失败日志。" } }, defaultPort: 3104, createPlugin: (e) => createJenkinsPlugin({ config: loadJenkinsPluginConfig(e) }), createConfigManager: createJenkinsConfigManager };
