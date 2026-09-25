// ---------------------------------------------------------------------------
// EAG — 受治理的终端
//
// 平台内 shell 会话。与普通"内嵌终端"的区别：
//   1. 每条命令先过命令策略，命危黑名单的直接不执行
//   2. 全部命令（含被阻断的）写入审计日志
//   3. 工作目录限制在项目根之内
//
// 实现说明：没有使用 node-pty（原生模块，需要编译，打包链路成本高），
// 而是 spawn 一个非交互 shell 并通过 stdio 管道读写。代价是不支持
// vim / python REPL 这类需要 TTY 的全屏交互程序，但 ls / git / npm
// 等常规命令完全可用。
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { PROJECT_ROOT } from "../paths.ts";
import { sendToRenderer } from "../window.ts";
import { TERMINAL_EVENT } from "../../shared/ipc-channels.ts";
import { inspectCommand } from "./command-policy.ts";
import * as executionBus from "./execution-bus.ts";
import type { TerminalStatus } from "../../shared/types.ts";

interface ShellSession {
  proc: ChildProcess;
  cwd: string;
  shell: string;
  startedAt: number;
  blockedCount: number;
  buffer: string;
  /** 当前正在收集输出的事件 id */
  activeEventId?: string;
}

const sessions = new Map<string, ShellSession>();

/** 单会话输出缓冲上限，防止失控命令把内存打满。 */
const MAX_BUFFER = 256 * 1024;

// ---------------------------------------------------------------------------
// 输出处理
// ---------------------------------------------------------------------------

/** 去掉 ANSI 转义与 CR，保留纯文本。 */
function sanitize(raw: string): string {
  return raw
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1B\][^\x07\x1B]*(\x07|\x1B\\)/g, "")
    .replace(/\x1B[()][A-Z0-9]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function emit(sessionId: string, text: string): void {
  sendToRenderer(TERMINAL_EVENT, { sessionId, text });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function shellSpec(): { cmd: string; args: string[] } {
  return process.platform === "win32"
    ? { cmd: "cmd.exe", args: ["/Q"] }
    : { cmd: "bash", args: [] };
}

export function startTerminal(sessionId: string, cwd?: string): TerminalStatus {
  stopTerminal(sessionId);

  const workDir = resolveCwd(cwd);
  const { cmd, args } = shellSpec();

  const proc = spawn(cmd, args, {
    cwd: workDir,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session: ShellSession = {
    proc,
    cwd: workDir,
    shell: cmd,
    startedAt: Date.now(),
    blockedCount: 0,
    buffer: "",
  };
  sessions.set(sessionId, session);

  const append = (text: string) => {
    session.buffer = (session.buffer + text).slice(-MAX_BUFFER);
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = sanitize(chunk.toString());
    append(text);
    if (session.activeEventId) executionBus.appendOutput(session.activeEventId, text);
    emit(sessionId, text);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = sanitize(chunk.toString());
    append(text);
    if (session.activeEventId) executionBus.appendOutput(session.activeEventId, text);
    emit(sessionId, text);
  });

  proc.on("exit", (code) => {
    const msg = `\n[终端已退出，退出码 ${code}]\n`;
    append(msg);
    emit(sessionId, msg);
    sessions.delete(sessionId);
  });

  proc.on("error", (err) => {
    const msg = `\n[无法启动 shell: ${err.message}]\n`;
    append(msg);
    emit(sessionId, msg);
    sessions.delete(sessionId);
  });

  if (process.platform === "win32") {
    // 切换 UTF-8 代码页避免中文乱码；关闭回显减少提示符噪音
    proc.stdin?.write("chcp 65001 > nul\n");
    proc.stdin?.write("@echo off\n");
  }

  emit(sessionId, `[终端已启动] ${cmd}  ·  ${workDir}\n`);
  return statusOf(sessionId);
}

/** 执行一条命令；先过策略，再落审计。 */
export function writeTerminal(sessionId: string, command: string): { sent: boolean; blocked: boolean; reason?: string } {
  const session = sessions.get(sessionId);
  if (!session || !session.proc.stdin?.writable) {
    return { sent: false, blocked: false, reason: "终端未启动" };
  }

  const trimmed = command.replace(/\s+$/, "");
  if (!trimmed) return { sent: false, blocked: false };

  const verdict = inspectCommand(trimmed);
  if (verdict.blocked) {
    session.blockedCount += 1;
    executionBus.record({
      source: "user",
      sessionId,
      command: trimmed,
      cwd: session.cwd,
      verdict: "blocked",
      blockedReason: verdict.reason,
    });
    emit(sessionId, `\n[已阻断] ${verdict.reason}：${trimmed}\n`);
    return { sent: false, blocked: true, reason: verdict.reason };
  }

  // 统一记录：与 Agent 通道共用同一结构与审计口径
  const event = executionBus.record({
    source: "user",
    sessionId,
    command: trimmed,
    cwd: session.cwd,
    verdict: "allowed",
  });
  session.activeEventId = event.id;

  session.proc.stdin.write(trimmed + "\n");
  return { sent: true, blocked: false };
}

export function stopTerminal(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  try {
    session.proc.kill("SIGTERM");
  } catch {
    // 进程可能已退出
  }
  sessions.delete(sessionId);
  return true;
}

export function clearTerminal(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) session.buffer = "";
  emit(sessionId, "\x00clear");
}

export function statusOf(sessionId: string): TerminalStatus {
  const session = sessions.get(sessionId);
  if (!session) {
    return { running: false, cwd: PROJECT_ROOT, shell: shellSpec().cmd, blockedCount: 0 };
  }
  return {
    running: true,
    cwd: session.cwd,
    shell: session.shell,
    startedAt: session.startedAt,
    blockedCount: session.blockedCount,
  };
}

/** 已有会话的输出缓冲，供前端重连时恢复。 */
export function bufferOf(sessionId: string): string {
  return sessions.get(sessionId)?.buffer ?? "";
}

/** 把 cwd 限制在项目根之内，防止终端跑到系统目录。 */
function resolveCwd(cwd?: string): string {
  if (!cwd) return PROJECT_ROOT;
  const abs = path.resolve(cwd);
  const root = path.resolve(PROJECT_ROOT);
  if (abs === root || abs.startsWith(root + path.sep)) return abs;
  return root;
}
