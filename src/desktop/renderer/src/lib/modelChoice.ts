/**
 * 会话级模型选择（按 用户 + Agent 存储，仅本地）。
 *
 * 模型配置的正确分层：
 *   1. Provider 池            —— 管理员在 Models 页维护（全局）
 *   2. Agent 默认模型          —— 管理员在 Worker 表单配置（worker.config）
 *   3. 会话级临时覆盖（本文件）  —— 用户为某个 Agent 临时换模型，
 *                                 只影响自己、只影响这个 Agent，不写全局配置。
 *
 * 解析优先级（见 WorkChat）：本地覆盖 → worker.config → 全局默认 Provider。
 */

import type { ModelProvider } from "@shared/types.ts";

export interface ModelChoice {
  providerId: string;
  modelName: string;
}

function scope(): string {
  try {
    return localStorage.getItem("eag-current-user") || "anon";
  } catch {
    return "anon";
  }
}

function key(workerId: string): string {
  return `eag-model-choice:${scope()}:${workerId}`;
}

export function getModelChoice(workerId: string): ModelChoice | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key(workerId)) || "null");
    if (raw && typeof raw.providerId === "string" && typeof raw.modelName === "string") {
      return raw as ModelChoice;
    }
  } catch {
    // 忽略
  }
  return null;
}

/** 保存覆盖；传 null 表示恢复 Agent 默认。 */
export function saveModelChoice(workerId: string, choice: ModelChoice | null): void {
  try {
    if (choice) localStorage.setItem(key(workerId), JSON.stringify(choice));
    else localStorage.removeItem(key(workerId));
  } catch {
    // 忽略
  }
}

/** 在 Provider 池中找一个模型的展示名（"Provider · model"）。 */
export function describeChoice(choice: ModelChoice, providers: ModelProvider[]): string {
  const p = providers.find((x) => x.id === choice.providerId);
  return p ? `${p.name} · ${choice.modelName}` : choice.modelName;
}
