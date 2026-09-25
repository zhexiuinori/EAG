// ---------------------------------------------------------------------------
// EAG Desktop — path resolution
//
// All main-process code is bundled into <root>/dist-electron/main.mjs, so
// per-file relative paths break after the build. Everything resolves against
// PROJECT_ROOT instead.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// In dev, EAG runs via `src/server/index.ts` and imports desktop services,
// so HERE may resolve to src/desktop or src/desktop/main depending on caller.
// Walk up until we find a directory containing package.json so PROJECT_ROOT
// always points at the real project root (where node_modules lives).
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, "..");
}

/** <root> of the EAG project (the directory containing package.json). */
export const PROJECT_ROOT = findProjectRoot(HERE);

/**
 * 运行时产物目录：构建脚本把 extension/ 与 launcher/ 编成 JS 放在这里。
 * 打包后没有 tsx 加载器，必须执行 JS；开发态产物不存在时回退到 .ts 源码。
 */
const RUNTIME_DIR = path.join(PROJECT_ROOT, "dist-electron", "runtime");

function resolveRuntimeFile(sourceFile: string): string {
  const rel = path.relative(path.join(PROJECT_ROOT, "src"), sourceFile);
  const compiled = path.join(RUNTIME_DIR, rel.replace(/\.ts$/, ".js"));
  return fs.existsSync(compiled) ? compiled : sourceFile;
}

/** Per-worker state root: <root>/.eag/workers/<workerId>/... */
export const WORKERS_DIR = path.join(PROJECT_ROOT, ".eag", "workers");

/** 记忆/会话持久化根：<root>/.eag/memory/... */
export const MEMORY_DIR = path.join(PROJECT_ROOT, ".eag", "memory");

export const EXTENSION_DIR = path.join(PROJECT_ROOT, "src", "extension");
export const POLICY_PATH = path.join(EXTENSION_DIR, "policy.json");
export const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
/** MCP 服务器配置（独立文件，避免与模型 Provider 配置互相污染）。 */
export const MCP_PATH = path.join(PROJECT_ROOT, "mcp.json");
/** 知识库（RAG）存储：<root>/.eag/knowledge/<collectionId>.json */
export const KNOWLEDGE_DIR = path.join(PROJECT_ROOT, ".eag", "knowledge");
/** 聊天附件落盘目录：<root>/.eag/uploads/<workerId>/ */
export const UPLOADS_DIR = path.join(PROJECT_ROOT, ".eag", "uploads");
/** 定时任务配置（管理员维护）。 */
export const SCHEDULES_PATH = path.join(PROJECT_ROOT, "schedules.json");
/** 站内通知（运行时状态，环形缓冲）。 */
export const NOTIFICATIONS_PATH = path.join(PROJECT_ROOT, ".eag", "notifications.json");
/**
 * 子 Agent 委派队列：<root>/.eag/delegations/<id>.{req,ack,res}.json
 * MCP 代理进程写 req、EAG 侧写 ack/res —— 同机文件通道，双模式通用。
 */
export const DELEGATIONS_DIR = path.join(PROJECT_ROOT, ".eag", "delegations");
export const DEFAULT_AUDIT_DIR = path.join(PROJECT_ROOT, "audit");
export const LAUNCHER_PATH = resolveRuntimeFile(
  path.join(PROJECT_ROOT, "src", "launcher", "eag-launch.ts"),
);
export const EAG_EXTENSION_ENTRY = resolveRuntimeFile(path.join(EXTENSION_DIR, "index.ts"));

/**
 * MCP 治理代理的构建产物路径。
 * 它会被 Agent 引擎当作 MCP server 直接 spawn，因此**必须是 JS**
 * （没有 tsx 加载器）。未构建时注入层会跳过注入 —— fail-safe。
 */
export const MCP_PROXY_PATH = path.join(
  PROJECT_ROOT, "dist-electron", "runtime", "desktop", "main", "mcp-proxy.js",
);

/**
 * Claude Code PreToolUse hook 路径。
 * 构建产物存在时用它（.mjs），开发态回退到 .ts 源码。
 */
const HOOK_BUILT = path.join(RUNTIME_DIR, "hooks", "pre-tool-use.mjs");
const HOOK_SOURCE = path.join(PROJECT_ROOT, "src", "desktop", "main", "hooks", "pre-tool-use.ts");
export const PRE_TOOL_USE_HOOK_PATH = fs.existsSync(HOOK_BUILT) ? HOOK_BUILT : HOOK_SOURCE;
