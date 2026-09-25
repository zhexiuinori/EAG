// ---------------------------------------------------------------------------
// EAG — 执行环境抽象（Workspace）
//
// 参考 OpenHands 的 Workspace 抽象：统一命令执行 / 文件操作接口，
// 环境隔离（容器 = 完全隔离主机）。
//
// 定位：EAG 现在做的是"操作治理"（工具级拦截/审计/审批），
// 缺的是"进程级隔离"——防止 agent 绕过工具直接 shell。
// 两者互补：Workspace 提供"跑不出去"的隔离，现有工具治理提供"看得见管得住"。
//
// 第一阶段（ponytail）：
//   · 抽象出 Workspace 接口（isolate 即可，命令/文件操作后续再注入）
//   · LocalWorkspace：现状（直接跑在项目目录，不隔离）
//   · ContainerWorkspace：Docker 容器跑 agent（挂载项目 + 隔离环境）
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

/** 执行环境抽象。 */
export interface Workspace {
  /** 唯一标识（local / container-<id>） */
  readonly kind: string;
  /**
   * 为一次 agent 执行准备环境（启动容器 / 校验本地目录），返回工作目录。
   * 返回的 cwd 是 agent 应在此运行的工作目录。
   */
  prepare(workerId: string): Promise<string>;
  /** 释放环境（停容器 / 清理临时挂载）。 */
  teardown(): Promise<void>;
  /** 是否真正隔离（local=false, container=true）。 */
  get isolated(): boolean;
}

/** 项目根（作为容器挂载源 / 本地 cwd）。 */
import { PROJECT_ROOT } from "../paths.ts";

/**
 * 本地工作区：不隔离。agent 直接跑在项目目录。
 * 现状即此行为——不是"沙箱"，但保留为退路（无 Docker 环境可用）。
 */
export class LocalWorkspace implements Workspace {
  readonly kind = "local";
  get isolated(): boolean {
    return false;
  }
  async prepare(_workerId: string): Promise<string> {
    return PROJECT_ROOT;
  }
  async teardown(): Promise<void> {
    // 本地无需清理
  }
}

/**
 * Docker 容器工作区：真正隔离。agent 跑在容器里，只挂载项目目录。
 *
 * 用法（需本机已安装 Docker）：
 *   const ws = new ContainerWorkspace({ image: "node:22", network: "none" });
 *   const cwd = await ws.prepare(workerId);
 *   // spawn agent CLI, cwd: cwd
 *   await ws.teardown();
 *
 * 安全默认（呼应"跑不出去"）：
 *   · 容器无网络（--network none）或白名单
 *   · 仅挂载项目目录（-v PROJECT_ROOT:/workspace）
 *   · 非 root 运行（--user 1000:1000）
 */
export class ContainerWorkspace implements Workspace {
  readonly kind: string;
  get isolated(): boolean {
    return true;
  }

  private containerName: string | undefined;

  constructor(private opts: { image: string; network?: "none" | string; projectHostPath?: string; user?: string }) {
    this.kind = `container-${Date.now().toString(36)}`;
  }

  async prepare(workerId: string): Promise<string> {
    const docker = "docker";
    const name = `eag-ws-${workerId}-${Date.now().toString(36)}`;
    const hostPath = this.opts.projectHostPath || PROJECT_ROOT;

    const args = [
      "run", "-d",
      "--name", name,
      "--rm",
      "--network", this.opts.network || "none",
      "--user", this.opts.user || "1000:1000",
      "-v", `${hostPath}:/workspace`,
      "-w", "/workspace",
      this.opts.image,
      "sleep", "infinity",
    ];

    try {
      execFileSync(docker, args, { timeout: 60_000, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      throw new Error(`[Workspace] 启动容器失败：${(e as Error).message}`);
    }

    this.containerName = name;
    return "/workspace";
  }

  async teardown(): Promise<void> {
    if (!this.containerName) return;
    try {
      execFileSync("docker", ["rm", "-f", this.containerName], { timeout: 30_000, stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      // 容器可能已退出，忽略
    }
    this.containerName = undefined;
  }
}

/** 工厂：按配置返回工作区实例。 */
export function createWorkspace(opts?: { mode?: "local" | "docker"; image?: string; network?: "none" | string }): Workspace {
  if (opts?.mode === "docker" && opts.image) {
    return new ContainerWorkspace({ image: opts.image, network: opts.network });
  }
  return new LocalWorkspace();
}

// ---------------------------------------------------------------------------
// 自检：验证 Local 不隔离、Container 在无 Docker 时给出明确错误（而非挂着）。
// ---------------------------------------------------------------------------

function demo(): void {
  const assert = (label: string, cond: boolean) => {
    if (!cond) { console.error(`✗ ${label}`); process.exitCode = 1; }
    else console.log(`✓ ${label}`);
  };

  (async () => {
    const local = createWorkspace({ mode: "local" });
    assert("local 不隔离", !local.isolated);
    const cwd = await local.prepare("__test__");
    assert("local cwd 是项目根", cwd === PROJECT_ROOT);
    await local.teardown();
    assert("local teardown 无异常", true);

    // Container：预期要么确实跑起来（本机有 docker），要么给出明确错误（无 docker）
    const container = createWorkspace({ mode: "docker", image: "node:22" });
    try {
      const c = await container.prepare("__test__");
      assert("container 隔离", container.isolated);
      assert("container cwd 是 /workspace", c === "/workspace");
      await container.teardown();
      console.log("  (本机有 Docker，容器工作区已实测)");
    } catch (e) {
      assert("无 Docker 时明确报错（而非静默）", /启动容器失败/.test((e as Error).message));
    }

    console.log(process.exitCode ? "\n自检失败" : "\n自检通过");
  })();
}

const isMain = typeof process !== "undefined" && process.argv?.[1]?.includes("workspace");
if (isMain) demo();
