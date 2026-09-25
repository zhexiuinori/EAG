# EAG — Enterprise Agent Governance

企业级 AI 编码 Agent 治理平台：基于 [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 构建的 Electron 桌面应用，为 Claude Code、Codex、Pi 等多种编码 Agent 引擎统一加上**策略执行、审计、审批、预算与可观测**等治理能力。

> 当前版本 v0.1.0，处于早期开发阶段。

## 核心能力

- **多引擎接入（Adapter 模式）**：每个 Agent 引擎（claude-code / codex / pi，预留 qwenpaw / openclaw）实现统一的 `AgentAdapter` 接口即可接入。适配器只做启动参数构建与事件归一化，不做治理决策；治理能力通过 `AdapterCapabilities` 诚实声明。
- **命令与文件治理**：命令策略（command-policy / command-gate）、文件读写闸门（fs-gate / fs-filter）、出网白名单（egress）、PreToolUse 钩子拦截。
- **审批与审计**：工具调用前审批（approval-service）、全量审计日志（audit）、治理摘要（governance-summary）。
- **MCP 治理**：MCP 代理（mcp-proxy）与 MCP 治理层（mcp-governance），统一管控 Agent 的 MCP 工具调用与委派链路深度（防无限递归）。
- **Swarm 多 Agent 模式**：任务拆解（task-decomposer）→ 编排（orchestrator）→ worker 池（worker-pool）→ 结果聚合（aggregator），支持 Agent 间委派。
- **工作台 UI**：WorkChat、AdminWorkers、Governance、Audit、Policy、Knowledge、Schedules、Swarm、Models、Inbox、Workspace、Settings 等页面，含登录与权限控制（RequireAuth / RequireAdmin）。
- **多模型提供商**：支持 Anthropic（含自定义路由）、OpenAI、DeepSeek、Ollama 本地模型，统一在 Models 页配置。

## 技术栈

Electron 34 · TypeScript 5 · React 19 · Vite 6 · Tailwind CSS 4 · zustand 5 · Express 5 · electron-builder

## 项目结构

```
src/
├── desktop/
│   ├── main/          # Electron 主进程：适配器、治理服务、IPC
│   │   ├── adapters/  # Agent 引擎适配器（claude-code / codex / pi / registry）
│   │   └── services/  # 审批、审计、命令策略、MCP 治理、调度等服务
│   ├── preload/       # 预加载脚本
│   ├── renderer/      # React 前端（页面 / 组件 / 状态 store）
│   └── shared/        # 主进程与渲染进程共享类型与 IPC 通道
├── extension/         # pi 扩展层：策略执行、fs / command / egress 闸门、审计
├── launcher/          # 启动器
├── server/            # 开发态 API 服务入口
└── swarm/             # 多 Agent 编排：拆解 / 编排 / worker 池 / 聚合
docs/                  # 设计文档
scripts/               # 构建与开发脚本
```

## 快速开始

环境要求：Node.js 20+、npm。

```bash
# 1. 安装依赖
npm install

# 2. 准备配置：复制示例配置（运行时加载项目根目录下的 config.json）
cp config.example.json config.json
# 按需修改提供商 baseUrl 与模型；API Key 用环境变量占位符引用（如 ${EAG_API_KEY_OPENAI}），
# 不要把明文密钥写进配置文件。

# 3. 设置所需的环境变量（按你启用的提供商）
export EAG_API_KEY_OPENAI=...
export EAG_API_KEY_DEEPSEEK=...
export EAG_API_KEY_CLAUDE_ROUTER=...

# 4. 开发模式启动
npm run dev              # 桌面开发模式
npm run dev:api          # 仅 API 服务
npm run dev:ui           # 仅前端（Vite）

# 5. 构建与打包
npm run desktop:build    # 构建主进程 + 渲染进程
npm run desktop:start    # 构建后以 Electron 启动
npm run desktop:package  # 打包安装包（electron-builder）
```

Windows 下也可直接运行 `start.bat`。

## 开发脚本

| 命令 | 说明 |
|---|---|
| `npm run typecheck` | TypeScript 类型检查（tsc --noEmit） |
| `npm run dev` | 桌面开发模式 |
| `npm run dev:api` / `npm run dev:ui` | 分别启动 API 服务 / 前端 |
| `npm run desktop:build` | 构建主进程与渲染进程 |
| `npm run desktop:package` | 打包桌面安装包 |

> 注意：`npm run lint` 尚未配置，自动化测试框架也尚未接入，欢迎贡献。

## 文档

- [接入 Agent 引擎 — Adapter 开发指南](docs/接入Agent引擎-adapter开发指南.md)：新引擎接入的完整规范，以及「治理能力诚实声明」原则
- [用户工作台与 Agent 组合方案](docs/用户工作台与Agent组合方案.md)：用户端 /app 与管理端 /admin 的产品方案（待评审）

## 协作规范

本项目的会话级行为基线见 [AGENTS.md](AGENTS.md)：任务分诊、角色委派、阶段流水线与交付红线（单 PR 只做一件事、密钥只走环境变量、测试必须含真实断言等）。

## License

[MIT](LICENSE)
