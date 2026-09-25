// ---------------------------------------------------------------------------
// EAG Desktop — User Group Service
//
// 用户组是 Agent 分配的中间粒度：
//   单人分配（assignedUserIds） < 用户组（本文件） < 全员（type = project）
//
// 持久化：<项目根>/users/groups.json（users/ 已在 .gitignore 中忽略）。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "../paths.ts";
import type { UserGroup, GroupUpsertInput } from "../../shared/types.ts";

const GROUPS_DIR = path.join(PROJECT_ROOT, "users");

function groupsFile(): string {
  return path.join(GROUPS_DIR, "groups.json");
}

function load(): UserGroup[] {
  try {
    const raw = fs.readFileSync(groupsFile(), "utf-8");
    const list = JSON.parse(raw);
    return Array.isArray(list) ? (list as UserGroup[]) : [];
  } catch {
    return [];
  }
}

function save(groups: UserGroup[]): void {
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  fs.writeFileSync(groupsFile(), JSON.stringify(groups, null, 2), "utf-8");
}

export function listGroups(): UserGroup[] {
  return load();
}

/** 用户所属的组 id 列表（可见性展开用）。 */
export function listGroupIdsForUser(userId: string): string[] {
  return load()
    .filter((g) => g.memberIds.includes(userId))
    .map((g) => g.id);
}

export function upsertGroup(input: GroupUpsertInput): UserGroup {
  const groups = load();
  const memberIds = [...new Set(input.memberIds.filter(Boolean))];

  if (input.id) {
    const idx = groups.findIndex((g) => g.id === input.id);
    if (idx !== -1) {
      groups[idx] = { ...groups[idx], name: input.name, memberIds };
      save(groups);
      return groups[idx];
    }
  }

  const g: UserGroup = {
    id: `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: input.name,
    memberIds,
    createdAt: new Date().toISOString(),
  };
  groups.push(g);
  save(groups);
  return g;
}

export function deleteGroup(id: string): boolean {
  const groups = load();
  const next = groups.filter((g) => g.id !== id);
  if (next.length === groups.length) return false;
  save(next);
  return true;
}

/** 用户被删除时从所有组移除（避免悬挂成员）。 */
export function removeMemberFromAllGroups(userId: string): void {
  const groups = load();
  let dirty = false;
  for (const g of groups) {
    if (g.memberIds.includes(userId)) {
      g.memberIds = g.memberIds.filter((m) => m !== userId);
      dirty = true;
    }
  }
  if (dirty) save(groups);
}
