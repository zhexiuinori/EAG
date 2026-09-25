import { useEffect, useState, useCallback, Fragment } from "react";
import * as ipc from "../lib/ipc.ts";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import StatCard from "../components/StatCard.tsx";
import EmptyState from "../components/EmptyState.tsx";
import { useToast } from "../components/Toast.tsx";
import { IconSearch, IconList, IconCheck, IconShield, IconAlert, IconChevronDown } from "../components/icons.tsx";
import type { AuditEntry } from "@shared/types.ts";

function today() { return new Date().toISOString().slice(0, 10); }

export default function Audit() {
  const toast = useToast();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [date, setDate] = useState(today());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // 审计完整性校验结果（哈希链）
  const [integrity, setIntegrity] = useState<{ valid: boolean; brokenAt?: number; checked: number } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const verify = async () => {
    setVerifying(true);
    try {
      const r = await ipc.auditVerify(date);
      setIntegrity(r);
      if (r.valid) toast.success(`审计完整（${r.checked} 条，哈希链校验通过）`);
      else toast.error(`审计完整性受损：第 ${r.brokenAt} 条被篡改`);
    } catch (e) {
      setIntegrity(null);
      toast.error(`校验失败：${e}`);
    }
    setVerifying(false);
  };

  const load = useCallback(async (d: string, q?: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await ipc.auditList({ date: d, search: q || undefined, limit: 1000 });
      setEntries(r.entries as AuditEntry[]);
    } catch (e) {
      setError(String(e));
      setEntries([]);
      toast.error(`审计加载失败：${e}`);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { void load(date); }, [date, load]);

  const ok = entries.filter((e) => !e.isError && !e.reason).length;
  const blocked = entries.filter((e) => e.reason).length;
  const errs = entries.filter((e) => e.isError).length;

  const exportJson = async () => {
    try {
      const r = await ipc.auditList({ date, limit: 10000 });
      const blob = new Blob([JSON.stringify(r.entries, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`已导出 ${r.entries.length} 条记录`);
    } catch (e) {
      toast.error(`导出失败：${e}`);
    }
  };

  return (
    <PageShell
      title="Audit"
      description="按日检索治理事件；点击行可展开入参与结果"
      actions={
        <>
          <Button onClick={verify} disabled={verifying} icon={<IconCheck size={13} />}>
            {verifying ? "校验中…" : "校验完整性"}
          </Button>
          <Button onClick={exportJson} icon={<IconList size={13} />}>
            导出 JSON
          </Button>
        </>
      }
      scroll={false}
    >
      <div className="flex flex-col h-full gap-4">
        {/* 概览 */}
        <div className="shrink-0 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="条目总数" value={entries.length} hint="当前筛选结果" icon={<IconList size={13} />} />
          <StatCard label="正常" value={ok} tone="ok" icon={<IconCheck size={13} />} />
          <StatCard label="被拦截" value={blocked} tone={blocked > 0 ? "warn" : "default"} hint="策略阻断" icon={<IconShield size={13} />} />
          <StatCard label="错误" value={errs} tone={errs > 0 ? "danger" : "default"} icon={<IconAlert size={13} />} />
        </div>

        {/* 筛选 */}
        <div className="shrink-0 flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="field w-[150px]"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(date, search)}
            placeholder="搜索命令、路径、用户…"
            className="field flex-1 min-w-0"
          />
          <Button variant="primary" onClick={() => load(date, search)} icon={<IconSearch size={13} />}>
            搜索
          </Button>
          <Button onClick={() => { setDate(today()); setSearch(""); void load(today()); }}>
            今天
          </Button>
        </div>

        {/* 审计完整性（哈希链）状态 */}
        {integrity && (
          <div className={`shrink-0 px-3 py-2 rounded-lg border text-[11px] ${
            integrity.valid ? "bg-green-bg border-green/30 text-green" : "bg-red-bg border-red/30 text-red"
          }`}>
            {integrity.valid
              ? `✓ 审计完整性校验通过（${integrity.checked} 条，哈希链未篡改）`
              : `⚠ 审计完整性受损：第 ${integrity.brokenAt} 条被篡改（哈希链断裂）`}
          </div>
        )}

        {/* 列表 */}
        <div className="flex-1 min-h-0 card overflow-auto">
          {loading ? (
            <div className="px-4 py-10 text-center text-[11.5px] text-fg-faint">加载中…</div>
          ) : error ? (
            <div className="px-4 py-10 text-center text-[11.5px] text-red">{error}</div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<IconList size={18} />}
              title="这一天没有审计记录"
              description="可切换日期或调整搜索条件；Web 模式下暂不支持审计检索。"
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-24">时间</th>
                  <th className="w-24">用户</th>
                  <th className="w-40">工具</th>
                  <th className="w-16">阶段</th>
                  <th>路径 / 命令</th>
                  <th className="w-20">状态</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const rowId = `${e.timestamp}-${i}`;
                  const isOpen = expanded === rowId;
                  const input = (e.input ?? {}) as Record<string, unknown>;
                  const target =
                    (typeof input.path === "string" && input.path) ||
                    (typeof input.command === "string" && input.command) ||
                    "—";
                  return (
                    <Fragment key={rowId}>
                      <tr
                        onClick={() => setExpanded(isOpen ? null : rowId)}
                        className="cursor-pointer"
                      >
                        <td className="font-mono text-[11px] text-fg-faint whitespace-nowrap">
                          {new Date(e.timestamp).toLocaleTimeString()}
                        </td>
                        <td className="text-[11.5px] truncate">{e.userId}</td>
                        <td>
                          <span className="font-mono text-[11px] text-blue">{e.toolName}</span>
                        </td>
                        <td>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            e.phase === "call" ? "bg-blue-bg text-blue" : "bg-green-bg text-green"
                          }`}>
                            {e.phase === "call" ? "调用" : "结果"}
                          </span>
                        </td>
                        <td className="font-mono text-[11px] truncate max-w-0" title={String(target)}>
                          {target}
                        </td>
                        <td>
                          {e.toolName === "__content_guardrail" ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-bg text-red font-medium" title={e.reason}>
                              疑似泄露
                            </span>
                          ) : e.isError ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-bg text-red font-medium">错误</span>
                          ) : e.reason ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-bg text-yellow font-medium" title={e.reason}>
                              已拦截
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-bg text-green font-medium">正常</span>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={6} className="bg-n-950/60">
                            <div className="px-1 py-1.5 space-y-2 text-[11px]">
                              <div className="flex items-center gap-2 text-fg-faint">
                                <IconChevronDown size={12} />
                                <span>详情</span>
                                {e.workerId && <span className="font-mono">worker: {e.workerId}</span>}
                                {e.costUsd != null && <span className="text-green">${e.costUsd.toFixed(4)}</span>}
                              </div>
                              {e.reason && (
                                <div>
                                  <span className="text-fg-faint">拦截原因：</span>
                                  <span className="text-yellow">{e.reason}</span>
                                </div>
                              )}
                              {e.input && (
                                <div>
                                  <div className="text-fg-faint mb-1">入参</div>
                                  <pre className="rounded-md border border-line bg-n-900 p-2 font-mono text-[10.5px] text-fg-subtle whitespace-pre-wrap max-h-40 overflow-auto">
                                    {JSON.stringify(e.input, null, 2)}
                                  </pre>
                                </div>
                              )}
                              {e.content && (
                                <div>
                                  <div className="text-fg-faint mb-1">结果</div>
                                  <pre className="rounded-md border border-line bg-n-900 p-2 font-mono text-[10.5px] text-fg-subtle whitespace-pre-wrap max-h-40 overflow-auto">
                                    {e.content.slice(0, 2000)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </PageShell>
  );
}
