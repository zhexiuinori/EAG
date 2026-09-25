// ---------------------------------------------------------------------------
// EAG — 通知（Notifications）
//
// 无人值守的最后一环：定时任务/后台事件完成后，光写审计是不够的 ——
// 用户不在电脑前时得能"喊到人"。两条通道：
//   · 站内：环形缓冲（<root>/.eag/notifications.json），顶栏铃铛可见
//   · 外推：可配置 Webhook（飞书/钉钉群机器人自动适配格式，其余按通用 JSON）
//
// 治理一致性：每条通知都写审计（__notification），"通知过什么"可追溯；
// 外推失败绝不影响主流程（fire-and-forget + 超时），并在站内明确标注失败状态。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { NOTIFICATIONS_PATH } from "../paths.ts";
import * as configApi from "./config-api.ts";
import * as auditApi from "./audit-api.ts";
import type {
  NotifyEvent, NotifyInput, NotificationListResult, NotificationTestResult,
} from "../../shared/types.ts";

/** 环形缓冲上限：站内通知足够回溯即可，不无限增长。 */
const MAX_ITEMS = 200;
const WEBHOOK_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function load(): NotifyEvent[] {
  try {
    const list = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, "utf-8"));
    return Array.isArray(list) ? (list as NotifyEvent[]) : [];
  } catch {
    return [];
  }
}

function save(items: NotifyEvent[]): void {
  try {
    fs.mkdirSync(path.dirname(NOTIFICATIONS_PATH), { recursive: true });
    fs.writeFileSync(NOTIFICATIONS_PATH, JSON.stringify(items, null, 2), "utf-8");
  } catch {
    // 落盘失败不影响内存中的通知
  }
}

let items: NotifyEvent[] = load();

// ---------------------------------------------------------------------------
// Webhook 外推
// ---------------------------------------------------------------------------

function webhookUrl(): string | undefined {
  const url = configApi.getConfig().notifyWebhook?.trim();
  return url || undefined;
}

/** 按目标平台组装 payload：飞书/钉钉群机器人的字段格式与通用 JSON 不同。 */
function buildPayload(ev: NotifyEvent, url: string): unknown {
  const text = [ev.title, ev.body].filter(Boolean).join("\n");
  if (/feishu\.cn|larksuite\.com/.test(url)) {
    // 飞书自定义机器人：{ msg_type: "text", content: { text } }
    return { msg_type: "text", content: { text } };
  }
  if (/dingtalk\.com/.test(url)) {
    // 钉钉自定义机器人：{ msgtype: "text", text: { content } }
    return { msgtype: "text", text: { content: text } };
  }
  // 通用：完整事件对象，便于自建接收端处理
  return { ...ev, text };
}

/** 外推（可等待版本，供"发送测试"用；notify() 内部走 fire-and-forget）。 */
async function postWebhook(ev: NotifyEvent): Promise<NotificationTestResult> {
  const url = webhookUrl();
  if (!url) return { ok: false, sent: false, error: "未配置 Webhook 地址（设置 → 通知）" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(ev, url)),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, sent: true, error: `HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true, sent: true };
  } catch (e: any) {
    return { ok: false, sent: true, error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

function createEvent(input: NotifyInput): NotifyEvent {
  return {
    id: `nt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: input.title,
    body: input.body,
    level: input.level ?? "info",
    source: input.source,
    at: new Date().toISOString(),
    read: false,
  };
}

/** 落站内缓冲 + 写审计（不含外推，外推由调用方决定方式）。 */
function record(ev: NotifyEvent): void {
  items.push(ev);
  if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
  save(items);

  // 审计："通知过什么"可追溯（与 __scheduled_run 同源可串起来看）
  auditApi.appendAuditEntry({
    userId: "system",
    workerId: undefined,
    toolName: "__notification",
    toolCallId: undefined,
    phase: "call",
    input: { title: ev.title, level: ev.level, source: ev.source },
    content: ev.body?.slice(0, 500),
    isError: ev.level === "error",
  });
}

/**
 * 产生一条通知：落站内缓冲 + 写审计 + 尝试外推。
 * 外推为 fire-and-forget：不阻塞调用方（定时任务执行路径），失败只打日志。
 */
export function notify(input: NotifyInput): NotifyEvent {
  const ev = createEvent(input);
  record(ev);

  if (webhookUrl()) {
    void postWebhook(ev).then((r) => {
      if (!r.ok) {
        console.error(`[Notify] Webhook 外推失败（${ev.source}）:`, r.error);
      }
    });
  }

  return ev;
}

export function list(): NotificationListResult {
  const sorted = [...items].sort((a, b) => (a.at < b.at ? 1 : -1));
  return { items: sorted, unread: items.filter((i) => !i.read).length };
}

/** 标记已读：给 ids 则只标这些，否则全部。 */
export function markRead(ids?: string[]): NotificationListResult {
  const target = ids && ids.length > 0 ? new Set(ids) : null;
  for (const it of items) {
    if (!target || target.has(it.id)) it.read = true;
  }
  save(items);
  return list();
}

export function clear(): boolean {
  items = [];
  save(items);
  return true;
}

/**
 * 发送测试通知：**等待外推结果**，让配置页能如实反馈成功/失败。
 * 同时落一条站内通知（用户可在铃铛里确认收到了什么）。
 */
export async function test(): Promise<NotificationTestResult> {
  // 注意：这里不能走 notify() —— 那会 fire-and-forget 发一次，
  // 再被下面的 await 发第二次（外推重复）。
  const ev = createEvent({
    title: "EAG 测试通知",
    body: "如果你在群里看到这条消息，说明 Webhook 配置成功。",
    level: "info",
    source: "test",
  });
  record(ev);

  const url = webhookUrl();
  if (!url) return { ok: false, sent: false, error: "未配置 Webhook 地址" };
  return postWebhook(ev);
}
