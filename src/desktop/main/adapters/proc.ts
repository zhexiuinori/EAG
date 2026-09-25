// ---------------------------------------------------------------------------
// EAG — 子进程终止工具
//
// 引擎是经 shell 拉起的（Windows 上 `codex` / `claude` 都是 .cmd 包装），
// 所以 child 实际是 cmd.exe，**真正的引擎进程是它的孙进程**。
//
// `child.kill()` 只杀掉 cmd：引擎变孤儿继续跑，而它继承的 stdout 管道不会关闭，
// adapter 侧 `for await (const line of rl)` 就永远不结束 ——
// 表现是"任务卡死、停止按钮点了没用、委派无限挂住"（本机实测踩到）。
// 因此 Windows 上必须用 taskkill /T 连整棵进程树一起终止。
// ---------------------------------------------------------------------------

import { spawnSync, type ChildProcess } from "node:child_process";

/** 终止子进程及其全部后代（尽力而为，不抛错）。 */
export function killProcessTree(child: ChildProcess | undefined | null): void {
  if (!child || child.pid == null) return;

  if (process.platform === "win32") {
    try {
      // /T 连子孙进程，/F 强制（控制台程序对 SIGTERM 并不总是响应）
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // 忽略：终止是尽力而为
    }
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // 忽略
  }
}
