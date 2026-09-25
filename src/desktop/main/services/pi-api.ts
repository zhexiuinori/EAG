import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { PiExecResult } from "../../shared/types.ts";
import { LAUNCHER_PATH } from "../paths.ts";

let piProcess: ChildProcess | null = null;
let piStartedAt: number | null = null;

export function startPi(extraArgs?: string[]): boolean {
  if (piProcess) return false;
  const args = extraArgs ?? [];
  piProcess = spawn("node", [LAUNCHER_PATH, ...args], {
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env },
  });
  piStartedAt = Date.now();
  piProcess.on("exit", () => { piProcess = null; piStartedAt = null; });
  piProcess.on("error", () => { piProcess = null; piStartedAt = null; });
  return true;
}

export function stopPi(): boolean {
  if (!piProcess) return false;
  piProcess.kill("SIGTERM");
  piProcess = null;
  piStartedAt = null;
  return true;
}

export function getPiStatus() {
  return { running: piProcess !== null && !piProcess.killed, pid: piProcess?.pid ?? null };
}

export function getPiUptime(): number {
  return piStartedAt ? Math.floor((Date.now() - piStartedAt) / 1000) : 0;
}

/**
 * 执行一次性 Pi 命令。
 *
 * 安全：使用 execFileSync 以参数数组形式调用，不经过 shell，
 * 因此 & | ` $() ; 等元字符不再具备注入能力（原实现仅转义双引号）。
 */
export function execPiCommand(command: string): PiExecResult {
  const start = Date.now();
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed) {
    return { success: false, output: "命令为空", durationMs: Date.now() - start };
  }
  try {
    const output = execFileSync(process.execPath, [LAUNCHER_PATH, "--print", trimmed], {
      encoding: "utf-8",
      timeout: 120_000,
      windowsHide: true,
      env: { ...process.env },
    });
    return { success: true, output: output.trim(), durationMs: Date.now() - start };
  } catch (err: any) {
    return { success: false, output: err.stderr || err.message, durationMs: Date.now() - start };
  }
}
