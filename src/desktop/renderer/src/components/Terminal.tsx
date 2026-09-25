import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc.ts";
import type { ExecutionEvent, ExecutionSource, TerminalStatus } from "@shared/types.ts";

/**
 * 执行面板 = 统一执行历史 + 受治理终端。
 *
 * 上半部分汇聚 Agent 与用户的所有命令执行（同一事件流、同一审计口径），
 * 下半部分是终端本身。
 *
 * 状态说明（不做伪装）：
 *   allowed  已放行 —— 经平台执行且通过策略
 *   blocked  已阻断 —— 被策略拒绝
 *   observed 已观测 —— 平台只能看到，当前无法拦截（claude / codex）
 */

interface Props {
  /** 会话标识，通常为 workerId */
  sessionId: string;
}

const MAX_OUTPUT = 200_000;

/** 轮询间隔：让 Agent 侧新产生的命令也能出现（无推送通道）。 */
const POLL_MS = 8000;

const VERDICT_LABEL: Record<ExecutionEvent["verdict"], string> = {
  allowed: "已放行",
  blocked: "已阻断",
  observed: "已观测",
};

const VERDICT_CLASS: Record<ExecutionEvent["verdict"], string> = {
  allowed: "text-green",
  blocked: "text-red",
  observed: "text-n-500",
};

export default function Terminal({ sessionId }: Props) {
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [executions, setExecutions] = useState<ExecutionEvent[]>([]);
  const [filter, setFilter] = useState<"all" | ExecutionSource>("all");

  const outRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ensureRunning = useCallback(async () => {
    const current = await ipc.terminalStatus({ sessionId });
    if (current.running) return current;
    return await ipc.terminalStart({ sessionId });
  }, [sessionId]);

  const loadExecutions = useCallback(async () => {
    try {
      const res = await ipc.executionList({ sessionId, limit: 200 });
      setExecutions(res.events ?? []);
    } catch {
      // 加载失败不阻塞终端使用
    }
  }, [sessionId]);

  useEffect(() => {
    let alive = true;

    const off = ipc.onTerminalEvent((chunk) => {
      if (chunk.sessionId !== sessionId) return;
      if (chunk.text === "\x00clear") {
        setOutput("");
        return;
      }
      setOutput((prev) => (prev + chunk.text).slice(-MAX_OUTPUT));
    });

    setBusy(true);
    ensureRunning()
      .then((s) => { if (alive) setStatus(s); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setBusy(false); });

    void loadExecutions();
    const timer = setInterval(() => { void loadExecutions(); }, POLL_MS);

    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, [sessionId, ensureRunning, loadExecutions]);

  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const submit = async () => {
    const cmd = input.trim();
    if (!cmd || busy) return;

    setInput("");
    setHistory((h) => [...h, cmd]);
    setHistIdx(-1);
    setOutput((prev) => (prev + `\n$ ${cmd}\n`).slice(-MAX_OUTPUT));

    try {
      await ipc.terminalWrite({ sessionId, command: cmd });
      setStatus(await ipc.terminalStatus({ sessionId }));
      await loadExecutions();
    } catch (e) {
      setOutput((prev) => (prev + `[错误] ${e instanceof Error ? e.message : String(e)}\n`).slice(-MAX_OUTPUT));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setInput(history[next]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx < 0) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setInput("");
      } else {
        setHistIdx(next);
        setInput(history[next]);
      }
    }
  };

  const clear = async () => {
    setOutput("");
    await ipc.terminalClear({ sessionId }).catch(() => {});
  };

  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      await ipc.terminalStop({ sessionId });
      setStatus(await ipc.terminalStart({ sessionId }));
      setOutput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const shown = filter === "all" ? executions : executions.filter((e) => e.source === filter);
  const blockedCount = executions.filter((e) => e.verdict === "blocked").length;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 统一执行历史 */}
      <div className="shrink-0 mb-3">
        <div className="flex items-center gap-1.5 mb-2">
          {([["all", "全部"], ["agent", "Agent"], ["user", "我的"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                filter === key ? "bg-primary-bg text-primary" : "text-n-500 hover:text-n-300"
              }`}
            >
              {label}
            </button>
          ))}
          <span className="text-[10px] text-n-600">
            {executions.length} 条
            {blockedCount > 0 && <span className="text-red"> · {blockedCount} 条阻断</span>}
          </span>
        </div>

        <div className="max-h-44 overflow-auto rounded-lg border border-line bg-n-950/60">
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-[10px] text-n-600">暂无执行记录</p>
          ) : (
            shown.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-2 px-3 py-1 border-b border-line/40 last:border-b-0 text-[10px]"
              >
                <span className={`shrink-0 ${e.source === "agent" ? "text-blue" : "text-n-400"}`}>
                  {e.source === "agent" ? "agent" : "我"}
                </span>
                <span className="font-mono text-n-300 truncate flex-1" title={e.command}>
                  {e.command}
                </span>
                <span
                  className={`shrink-0 ${VERDICT_CLASS[e.verdict]}`}
                  title={e.verdict === "observed"
                    ? "平台仅能观测到该命令，当前引擎尚不支持在平台侧拦截"
                    : e.blockedReason}
                >
                  {VERDICT_LABEL[e.verdict]}
                </span>
                <span className="shrink-0 text-n-600">
                  {new Date(e.startedAt).toLocaleTimeString()}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 终端状态栏 */}
      <div className="flex items-center gap-2 mb-2 text-[10px] shrink-0">
        <span className={status?.running ? "text-green" : "text-n-600"}>
          {status?.running ? "● 运行中" : "○ 已停止"}
        </span>
        {status?.shell && <span className="text-n-500 font-mono">{status.shell}</span>}
        {status?.cwd && (
          <span className="text-n-600 font-mono truncate" title={status.cwd}>{status.cwd}</span>
        )}
        {!!status?.blockedCount && (
          <span className="text-yellow">{status.blockedCount} 条被策略阻断</span>
        )}
        <div className="flex-1" />
        <button
          onClick={clear}
          className="px-2 py-0.5 rounded border border-n-700 text-n-400 hover:text-n-200 hover:border-n-600 transition-colors"
        >
          清空
        </button>
        <button
          onClick={restart}
          disabled={busy}
          className="px-2 py-0.5 rounded border border-n-700 text-n-400 hover:text-n-200 hover:border-n-600 transition-colors disabled:opacity-50"
        >
          重启
        </button>
      </div>

      {error && (
        <div className="mb-2 px-2 py-1 rounded bg-red-bg border border-red/30 text-red text-[10px]">
          {error}
        </div>
      )}

      {/* 输出区 */}
      <pre
        ref={outRef}
        onClick={() => inputRef.current?.focus()}
        className="flex-1 min-h-0 overflow-auto bg-n-950 border border-line rounded-lg p-3 font-mono text-[11px] leading-relaxed text-n-300 whitespace-pre-wrap break-all"
      >
        {output || (busy ? "启动中…" : "尚无输出")}
      </pre>

      {/* 输入行 */}
      <div className="mt-2 flex items-center gap-2 shrink-0">
        <span className="text-primary font-mono text-xs select-none">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入命令（↑↓ 查看历史）"
          disabled={busy || !status?.running}
          className="flex-1 px-3 py-1.5 bg-n-900 border border-n-700 rounded-lg text-xs font-mono text-n-200 placeholder-n-600 outline-none focus:border-primary-strong transition-all disabled:opacity-50"
        />
      </div>

      <p className="mt-1.5 text-[10px] text-n-600 shrink-0">
        命令受策略约束并全部记录审计；不支持 vim 等需要 TTY 的全屏交互程序
      </p>
    </div>
  );
}
