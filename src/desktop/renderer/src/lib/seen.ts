/**
 * "已查看过的 Agent"记录（按用户隔离）。
 *
 * 用途：管理员新分配给用户的 Agent 在用户侧标记 NEW，为用户提供
 * "有新东西"的感知 —— 此前分配是静默的，用户完全不知道多了什么。
 */

const PREFIX = "eag-seen-agents:";

function scope(): string {
  try {
    return localStorage.getItem("eag-current-user") || "anon";
  } catch {
    return "anon";
  }
}

export function getSeenAgentIds(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFIX + scope()) || "[]");
    return new Set(Array.isArray(raw) ? (raw as string[]) : []);
  } catch {
    return new Set();
  }
}

/** 标记 Agent 为已查看（进入会话 / 点击卡片时调用）。 */
export function markAgentsSeen(ids: string[]): void {
  try {
    const seen = getSeenAgentIds();
    let dirty = false;
    for (const id of ids) {
      if (id && !seen.has(id)) {
        seen.add(id);
        dirty = true;
      }
    }
    if (!dirty) return;
    // 只保留最近 200 条，避免无限增长
    const list = [...seen].slice(-200);
    localStorage.setItem(PREFIX + scope(), JSON.stringify(list));
  } catch {
    // 忽略
  }
}
