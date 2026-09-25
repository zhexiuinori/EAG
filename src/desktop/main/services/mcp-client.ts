// ---------------------------------------------------------------------------
// EAG — MCP stdio client (JSON-RPC 2.0)
//
// 一个 MCP server 子进程的连接封装。被两处复用：
//   · services/mcp-service.ts —— EAG 侧纳管（列工具、测试调用）
//   · mcp-proxy.ts            —— 代理进程内连真实 server（Agent 调用走这里）
// 抽出来是为了让"进程 + 协议"只有一份实现，代理与服务侧行为一致。
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 进程退出回调（用于上层清理）。 */
  onExit?: () => void;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

/** 原始 tools/list 条目（协议形态，未加命名空间）。 */
export interface McpRawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class McpStdioClient {
  private proc: ChildProcess | undefined;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 1;
  private handshaken = false;

  constructor(private readonly opts: McpClientOptions) {}

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  /** 启动子进程并完成 initialize 握手（幂等）。 */
  async start(): Promise<void> {
    if (this.running) return;

    const proc = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.buffer = "";
    this.handshaken = false;

    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    // MCP server 的日志走 stderr，不干扰协议帧；此处丢弃
    proc.stderr?.on("data", () => {});

    proc.on("exit", () => {
      for (const [, w] of this.pending) w.reject(new Error("MCP 进程已退出"));
      this.pending.clear();
      this.proc = undefined;
      this.opts.onExit?.();
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "EAG", version: "0.1.0" },
    });
    this.handshaken = true;
    this.notify("notifications/initialized", {});
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    // MCP stdio：换行分隔的 JSON-RPC 消息
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 忽略非 JSON 输出（server 可能混入日志）
      }
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message ?? "MCP 调用失败"));
        else waiter.resolve(msg.result);
      }
    }
  }

  /** 发请求并等待响应。 */
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return Promise.reject(new Error("MCP 进程未运行"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** 发通知（无响应）。 */
  notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async listTools(timeoutMs = 30_000): Promise<McpRawTool[]> {
    const res = await this.request("tools/list", {}, timeoutMs);
    return (res?.tools ?? []) as McpRawTool[];
  }

  callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  /** 是否已完成 initialize 握手。 */
  get ready(): boolean {
    return this.handshaken && this.running;
  }

  stop(): void {
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
    this.proc = undefined;
  }
}
