/**
 * 一键启动 Web 开发环境：后端 API (3789) + 前端 UI (5173)。
 *
 * 解决的问题：
 *   - 原先需要开两个终端分别启动，容易只起了一个却以为失败了
 *   - 原 `desktop:dev` 用 Windows 的 `start /B`，在 PowerShell / 非 cmd
 *     的 script-shell 下无法工作
 *   - 停止时两个服务需要一起退出，否则残留进程会占住端口
 *
 * 不引入 concurrently 之类的新依赖，Ctrl+C 时统一杀掉进程树。
 */

import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const RESET = "\x1b[0m";
const targets = [
  { name: "api", script: "dev:api", color: "\x1b[36m" }, // cyan
  { name: "ui", script: "dev:ui", color: "\x1b[35m" },   // magenta
];

/** 给子进程的每一行输出加上 [api] / [ui] 前缀。 */
function linePrefixer(prefix) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`${prefix}${line}\n`);
    }
  };
}

const children = [];

for (const target of targets) {
  const child = spawn(npm, ["run", target.script], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    // Windows 上 .cmd 不能被直接 spawn（会报 spawn EINVAL），需要经由 shell
    shell: process.platform === "win32",
  });

  const prefix = `${target.color}[${target.name}]${RESET} `;
  child.stdout.on("data", linePrefixer(prefix));
  child.stderr.on("data", linePrefixer(prefix));

  child.on("exit", (code) => {
    process.stdout.write(`\n${prefix}进程退出（code=${code}），正在关闭其余服务…\n`);
    shutdown(code ?? 1);
  });

  children.push(child);
}

let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.killed || child.exitCode !== null) continue;
    if (process.platform === "win32") {
      // Windows 没有 POSIX 信号；/T 杀掉整棵进程树（含 npm.cmd 拉起的 node）
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => process.exit(code), 400);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

process.stdout.write(
  `\n  EAG 开发环境启动中…\n` +
  `  API   http://localhost:3789\n` +
  `  UI    http://localhost:5173\n\n` +
  `  按 Ctrl+C 同时停止两个服务\n\n`,
);
