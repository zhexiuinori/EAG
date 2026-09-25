// ---------------------------------------------------------------------------
// EAG — 受治理的文件访问服务
//
// 执行平台的文件工作区后端。与"直接用 fs"的区别在于：
//   每一次读写都先过策略引擎，并写入审计日志。
// 这正是 EAG 相对 OpenHands / Devin 那类裸编辑器的差异点。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "../paths.ts";
import { isAccessAllowed, matchPolicy, resolvePolicyMap } from "../../../extension/policy.ts";
import * as policyApi from "./policy-api.ts";
import * as auditApi from "./audit-api.ts";
import type {
  FileEntry, FileListResult, FileReadResult, FileWriteResult,
} from "../../shared/types.ts";

/** 单文件读取上限，避免把大文件灌进渲染进程。 */
const MAX_READ_BYTES = 512 * 1024;

/** 单层目录最多返回条目数。 */
const MAX_DIR_ENTRIES = 500;

const SKIP_NAMES = new Set([".git", "node_modules", ".eag", "dist", "dist-electron", "release"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 展开策略变量后判定，与治理扩展保持一致。 */
function policies() {
  return resolvePolicyMap(policyApi.getPolicy(), { projectRoot: PROJECT_ROOT });
}

function auditFileOp(op: "read" | "write", target: string, ok: boolean, reason?: string): void {
  auditApi.appendAuditEntry({
    userId: "console",
    workerId: undefined,
    toolName: `platform_file_${op}`,
    toolCallId: undefined,
    phase: "call",
    input: { path: target },
    isError: !ok,
    reason,
  });
}

/**
 * 必须用 matchPolicy（最长前缀优先）而不是数组 find：
 * 策略表是先宽后窄排列的，find 会让 `${PROJECT_ROOT}`(rw) 先命中，
 * 从而覆盖掉 `${PROJECT_ROOT}/.env`(r) 这类更具体的规则。
 */
function accessOf(target: string): "rw" | "r" | "hidden" {
  const entry = matchPolicy(target, policies());
  return entry?.access ?? "hidden"; // 默认拒绝
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** 列出目录内容；hidden 条目直接不返回（对 UI 不可见）。 */
export function listDir(dirPath: string): FileListResult {
  const root = path.resolve(dirPath || PROJECT_ROOT);

  // 目录本身不可见时，返回空列表而不是抛错
  if (!isAccessAllowed(root, "read", policies())) {
    return { root, parent: null, entries: [], writable: false };
  }

  let entries: FileEntry[] = [];
  try {
    const items = fs.readdirSync(root, { withFileTypes: true });
    for (const item of items) {
      if (SKIP_NAMES.has(item.name)) continue;
      const full = path.join(root, item.name);
      const access = accessOf(full);
      if (access === "hidden") continue;

      entries.push({
        name: item.name,
        path: full,
        type: item.isDirectory() ? "dir" : "file",
        access,
        size: item.isFile() ? safeSize(full) : undefined,
      });
    }
  } catch {
    entries = [];
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = path.dirname(root);
  const hasParent = parent !== root && root !== path.parse(root).root;

  return {
    root,
    parent: hasParent ? parent : null,
    entries: entries.slice(0, MAX_DIR_ENTRIES),
    writable: isAccessAllowed(root, "write", policies()),
  };
}

/** 读取文件内容，受策略约束并记录审计。 */
export function readFile(target: string): FileReadResult {
  const abs = path.resolve(target);
  const access = accessOf(abs);

  if (!isAccessAllowed(abs, "read", policies())) {
    auditFileOp("read", abs, false, access === "hidden" ? "路径不可见" : "策略拒绝读取");
    return { ok: false, path: abs, error: "该文件不可读（策略拒绝）", access };
  }

  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      return { ok: false, path: abs, error: "不是文件", access };
    }
    const truncated = stat.size > MAX_READ_BYTES;
    const content = fs.readFileSync(abs, "utf-8").slice(0, MAX_READ_BYTES);
    auditFileOp("read", abs, true);
    return { ok: true, path: abs, content, access, truncated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    auditFileOp("read", abs, false, message);
    return { ok: false, path: abs, error: message, access };
  }
}

/** 写入文件，必须先通过写策略；写前抓快照供 diff 使用。 */
export function writeFile(target: string, content: string): FileWriteResult {
  const abs = path.resolve(target);

  if (!isAccessAllowed(abs, "write", policies())) {
    auditFileOp("write", abs, false, "策略拒绝写入");
    return { ok: false, path: abs, error: "该文件不可写（策略拒绝）" };
  }

  try {
    // 与 worker-service 一致：写前抓快照，供内容级 diff
    let preImage: string | undefined;
    try {
      preImage = fs.readFileSync(abs, "utf-8");
    } catch {
      preImage = undefined; // 新建文件
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");

    auditApi.appendAuditEntry({
      userId: "console",
      workerId: undefined,
      toolName: "platform_file_write",
      toolCallId: undefined,
      phase: "call",
      input: { path: abs },
      preImage,
    });

    return { ok: true, path: abs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    auditFileOp("write", abs, false, message);
    return { ok: false, path: abs, error: message };
  }
}

function safeSize(p: string): number | undefined {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}
