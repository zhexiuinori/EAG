/**
 * Policy: path-based access control model.
 *
 * Three access tiers:
 *   "rw"      - read + write allowed
 *   "r"       - read only (read/ls/grep/find allowed, write/edit blocked)
 *   "hidden"  - file is invisible (all tools return ENOENT or empty results)
 *
 * Default: "hidden" (security-first).
 * Policy paths are case-insensitive on Windows, case-sensitive elsewhere.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessLevel = "rw" | "r" | "hidden";

export interface PolicyEntry {
  /** Normalized absolute path */
  path: string;
  access: AccessLevel;
}

export type PolicyMap = PolicyEntry[];

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function isWindows(): boolean {
  return os.platform() === "win32";
}

/**
 * Resolve to a canonical absolute path, resolving symlinks for access-check
 * consistency. Symlinks inside the repo are resolved so a policy path like
 * "C:\data -> D:\real\data" is handled naturally.
 */
export function resolveRealPath(raw: string, cwd: string): string {
  const abs = path.resolve(cwd, raw);
  try {
    // realpath the entire path (file may not exist, so fallback to realpath parent dir)
    try {
      return fs.realpathSync(abs);
    } catch {
      // file doesn't exist yet — realpath the parent dir to catch symlink-in-directory attacks
      const parent = path.dirname(abs);
      const realParent = fs.realpathSync(parent);
      return path.join(realParent, path.basename(abs));
    }
  } catch {
    // parent dir doesn't exist either — fall back to unresolvable absolute
    return abs;
  }
}

/**
 * Normalise a policy path so it can be matched against real paths.
 * Returns the lower-case form on Windows.
 */
export function normaliseForMatch(p: string): string {
  // Strip trailing slash so "/path/" matches "/path" and "/path/file"
  const stripped = p.replace(/\/+$/, "").replace(/\\+$/, "");
  const normalised = stripped.replace(/\\/g, "/");
  return isWindows() ? normalised.toLowerCase() : normalised;
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

/**
 * Longest-prefix-first match against policy entries.
 * Returns the policy entry with the deepest path that is a prefix of `realPath`.
 *
 * Examples (given policies `["/data" → "r", "/data/secret" → "hidden"]`):
 *   "/data/public/file.txt"  →  "r"
 *   "/data/secret/keys.txt"  →  "hidden"
 *   "/etc/passwd"            →  undefined (→ "hidden")
 */
export function matchPolicy(realPath: string, policies: PolicyMap): PolicyEntry | undefined {
  const matchKey = normaliseForMatch(realPath);
  let best: PolicyEntry | undefined;

  for (const entry of policies) {
    const entryKey = normaliseForMatch(entry.path);
    if (matchKey === entryKey || matchKey.startsWith(entryKey + "/")) {
      if (!best || entry.path.length > best.path.length) {
        best = entry;
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Convenience check
// ---------------------------------------------------------------------------

export function isAccessAllowed(
  realPath: string,
  required: "read" | "write",
  policies: PolicyMap,
): boolean {
  const entry = matchPolicy(realPath, policies);
  if (!entry) return false; // default = hidden

  if (entry.access === "rw") return true;
  if (entry.access === "r") return required === "read";
  return false; // "hidden"
}

// ---------------------------------------------------------------------------
// Variable expansion — 让策略跨平台可移植
// ---------------------------------------------------------------------------

/**
 * 策略路径支持的变量：${PROJECT_ROOT}（等同 ${WORKSPACE}）、${HOME}、
 * ${USERPROFILE}、${TEMP}、${TMP}。
 *
 * 背景：默认策略原本写死 POSIX 路径 `/workspace/project`，在 Windows 上
 * 真实路径形如 `D:\project\EAG`，导致所有条目都不匹配 → 默认 deny →
 * Agent 读不到任何文件。变量展开让同一份策略在任意平台/任意检出路径下生效。
 */
const POLICY_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface PolicyContext {
  projectRoot?: string;
  home?: string;
}

function defaultContext(): Required<PolicyContext> {
  return {
    projectRoot: process.env.EAG_PROJECT_ROOT || process.cwd(),
    home: os.homedir(),
  };
}

export function expandPolicyPath(p: string, ctx: PolicyContext = {}): string {
  const c = { ...defaultContext(), ...ctx };
  const vars: Record<string, string> = {
    PROJECT_ROOT: c.projectRoot,
    WORKSPACE: c.projectRoot,
    HOME: c.home,
    USERPROFILE: c.home,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
  };
  return p.replace(POLICY_VARIABLE, (match, name: string) => vars[name] ?? match);
}

/** 展开策略表中的所有路径变量；未识别的变量原样保留。 */
export function resolvePolicyMap(policies: PolicyMap, ctx: PolicyContext = {}): PolicyMap {
  return policies.map((entry) => ({ ...entry, path: expandPolicyPath(entry.path, ctx) }));
}

// ---------------------------------------------------------------------------
// 合并 —— 修复"策略双轨制"
// ---------------------------------------------------------------------------

/**
 * 合并策略：Worker 级条目按路径覆盖全局条目，其余全局条目保留。
 *
 * 背景：此前全局策略（Policy 管理页）只被 Pi 引擎读取，Worker 级策略
 * （创建表单里的那条路径）只被 claude-code / codex 读取，两套各管一半，
 * 且界面上没有任何说明。管理员以为配了策略，实际只配了一半。
 *
 * 现在统一为：生效策略 = 全局默认 + Worker 覆盖，三个引擎读同一份。
 */
export function mergePolicies(base: PolicyMap, override: PolicyMap): PolicyMap {
  if (!override || override.length === 0) return base;
  if (!base || base.length === 0) return override;

  const merged = new Map<string, PolicyEntry>();
  for (const entry of base) merged.set(normaliseForMatch(entry.path), entry);
  // Worker 条目的顺序在后 → 覆盖同路径的全局条目
  for (const entry of override) merged.set(normaliseForMatch(entry.path), entry);

  return [...merged.values()];
}
