/**
 * fs-filter: tool_result handler that filters grep/find/ls output.
 *
 * Hidden paths are removed from tool result content so the LLM never sees them.
 * The handler does not throw — it silently strips entries.
 */

// 注意：SDK 未从包根导出 ToolResultEventResult（定义在
// dist/core/extensions/types.d.ts 的 tool_result handler 签名中），
// 因此这里依靠结构化类型推断，而不是显式引用该类型名。
import type { ToolResultEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRealPath, matchPolicy } from "./policy.ts";
import type { PolicyMap } from "./policy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reconstruct an absolute path from a relative path shown in tool output,
 * using the search root from event.input or ctx.cwd as fallback.
 */
function absoluteOf(relative: string, event: ToolResultEvent, cwd: string): string {
  const searchRoot = (event.input as Record<string, unknown>)?.path;
  const root = typeof searchRoot === "string" && searchRoot.length > 0
    ? resolveRealPath(searchRoot, cwd)
    : cwd;
  return resolveRealPath(relative, root);
}

function isHidden(realPath: string, policies: PolicyMap): boolean {
  const entry = matchPolicy(realPath, policies);
  return !entry || entry.access === "hidden";
}

// ---------------------------------------------------------------------------
// Line-level filters
// ---------------------------------------------------------------------------

/**
 * Filter a "find" result line (plain relative path).
 * Returns the line if visible, undefined if hidden.
 */
function filterFindLine(line: string, event: ToolResultEvent, cwd: string, policies: PolicyMap): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return line;
  const realPath = absoluteOf(trimmed, event, cwd);
  return isHidden(realPath, policies) ? undefined : line;
}

/**
 * Filter a "grep" result line.
 * Format: `relativePath:lineNumber: text` or `relativePath-lineNumber- text` (context).
 */
function filterGrepLine(line: string, event: ToolResultEvent, cwd: string, policies: PolicyMap): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return line;

  // Match the first path-like segment before `:` or `-` at the start of the line.
  // Examples: "src/foo.ts:42: const x = 1" or "src/foo.ts-41- // comment"
  const colonMatch = trimmed.match(/^(.+?):(\d+):/);
  const dashMatch = !colonMatch ? trimmed.match(/^(.+?)-(\d+)- /) : null;
  const match = colonMatch || dashMatch;
  if (!match) return line; // can't identify path, pass through

  const relativePath = match[1];
  const realPath = absoluteOf(relativePath, event, cwd);
  return isHidden(realPath, policies) ? undefined : line;
}

/**
 * Filter an "ls" result line.
 * Format is platform-dependent; we try to extract the last token as the filename.
 * This is inherently less precise — we use a best-effort approach.
 */
function filterLsLine(line: string, event: ToolResultEvent, cwd: string, policies: PolicyMap): string | undefined {
  const trimmed = line.trimEnd();
  if (!trimmed) return line;

  // Skip non-file lines (total count, empty, directory headers, permission lines without filename)
  if (
    trimmed.startsWith("total ") ||
    trimmed.startsWith("dr") || trimmed.startsWith("-r") ||
    trimmed.startsWith("l") || trimmed.startsWith("cr") ||
    trimmed.startsWith("br") || trimmed.startsWith("sr")
  ) {
    return line;
  }

  // Try to match a path suffix — "foo/bar.txt" or "bar.txt"
  const pathMatch = trimmed.match(/(.+[/\\])?([^/\\]+)$/);
  if (!pathMatch) return line;

  const filename = pathMatch[2];
  // If it looks like a regular filename (contains dot or is short), try to resolve it
  if (filename.includes(".") || filename.length < 50) {
    const realPath = absoluteOf(filename, event, cwd);
    if (isHidden(realPath, policies)) return undefined;
  }

  return line;
}

// ---------------------------------------------------------------------------
// Main filter
// ---------------------------------------------------------------------------

function filterContent(
  lines: string,
  event: ToolResultEvent,
  cwd: string,
  policies: PolicyMap,
): string {
  const lineFilter = getLineFilter(event.toolName);

  const filtered = lines.split("\n").map((line) => lineFilter(line, event, cwd, policies));
  const result = filtered.filter((l): l is string => l !== undefined).join("\n");

  // If everything was stripped, return empty message
  if (result.trim() === "") {
    return event.toolName === "find"
      ? "No files found matching pattern"
      : event.toolName === "grep"
        ? "No matches found"
        : "";
  }

  return result;
}

function getLineFilter(
  toolName: string,
): (line: string, event: ToolResultEvent, cwd: string, policies: PolicyMap) => string | undefined {
  switch (toolName) {
    case "find":
      return filterFindLine;
    case "grep":
      return filterGrepLine;
    case "ls":
      return filterLsLine;
    default:
      return () => undefined; // unreachable
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * tool_result handler 的返回结构。
 * SDK 未从包根导出 ToolResultEventResult，这里用索引访问类型等价声明，
 * 避免推断类型落到嵌套依赖（pi-ai）上导致类型不可命名。
 */
interface ToolResultPatch {
  content: ToolResultEvent["content"];
}

export function createFsFilterHandler(policies: PolicyMap) {
  return async (event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultPatch | void> => {
    if (!["grep", "find", "ls"].includes(event.toolName)) {
      return; // not our concern
    }

    const cwd = ctx.cwd || process.cwd();

    // Process text content blocks
    let modified = false;
    const newContent = event.content.map((block) => {
      if (block.type !== "text") return block;

      const filtered = filterContent(block.text, event, cwd, policies);
      if (filtered === block.text) return block;

      modified = true;
      return { type: "text" as const, text: filtered };
    });

    if (!modified) return undefined;

    return { content: newContent };
  };
}
