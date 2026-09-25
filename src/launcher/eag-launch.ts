/**
 * EAG Worker Launcher
 *
 * 启动一个被治理的 Pi 子进程。三种模式：
 *
 *   1. 批处理（Swarm）—— node eag-launch.ts --task '<WorkerTaskSpec JSON>'
 *      解析任务规格 → 构造 prompt → 以 --print 非交互模式运行
 *      → 将输出写入 spec.outputLocation → 以 Agent 退出码退出。
 *
 *   2. 一次性命令 —— node eag-launch.ts --print '<prompt>'
 *
 *   3. 交互（兼容旧行为）—— node eag-launch.ts
 *
 * 注意：此前本文件完全不解析 argv，导致 worker-pool 传来的 --task 被忽略、
 * outputLocation 从未被写入，Swarm 整条链路产出为空。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface WorkerTaskSpec {
  taskId: string;
  title: string;
  description: string;
  input: unknown;
  outputLocation: string;
}

// ── 1. 身份解析 ──────────────────────────────────────────────────
const userId =
  process.env.EAG_USER_ID ||
  process.env.USERNAME ||
  process.env.USER;

if (!userId) {
  console.error('[eag-launch] 错误: 无法确定用户身份（未设置 EAG_USER_ID / USERNAME / USER）');
  process.exit(1);
}

// ── 2. eagRoot ────────────────────────────────────────────────────
const eagRoot = process.env.EAG_ROOT ?? path.resolve(process.cwd(), '..');

// ── 3. per-user agent 目录 ─────────────────────────────────────────
const agentDir = path.join(eagRoot, 'users', userId, 'agent');

fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(agentDir, 0o700);
} catch {
  // Windows 上 chmod 可能不支持，忽略
}

// ── 4. 治理扩展路径 ───────────────────────────────────────────────
const governanceExtension = path.resolve(__dirname, '../extension/index.ts');

// ── 5. Pi 路径 ────────────────────────────────────────────────────
const piPath = process.env.PI_PATH ?? 'pi';

const childEnv = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: '1',
};

// ── 6. 参数解析 ───────────────────────────────────────────────────

interface LaunchArgs {
  task?: WorkerTaskSpec;
  print?: string;
}

function parseArgs(argv: string[]): LaunchArgs {
  const out: LaunchArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--task') {
      const raw = argv[++i];
      if (!raw) throw new Error('--task 缺少参数');
      out.task = JSON.parse(raw) as WorkerTaskSpec;
    } else if (arg === '--print') {
      const raw = argv[++i];
      if (raw === undefined) throw new Error('--print 缺少参数');
      out.print = raw;
    }
  }
  return out;
}

/** 由任务规格构造送给 Agent 的 prompt。 */
function buildPrompt(spec: WorkerTaskSpec): string {
  const input = (spec.input ?? {}) as { prompt?: string };
  return [`# ${spec.title}`, spec.description, '', input.prompt ?? '']
    .filter((s) => s !== undefined && s !== '')
    .join('\n');
}

/** 写入任务输出；目录不存在时自动创建。 */
function writeOutput(spec: WorkerTaskSpec, content: string): void {
  try {
    fs.mkdirSync(path.dirname(spec.outputLocation), { recursive: true });
    fs.writeFileSync(spec.outputLocation, content, 'utf-8');
  } catch (err) {
    console.error(`[eag-launch] 写入输出失败 ${spec.outputLocation}: ${(err as Error).message}`);
  }
}

// ── 7. 批处理执行 ─────────────────────────────────────────────────

function runBatch(prompt: string, spec?: WorkerTaskSpec): Promise<number> {
  return new Promise((resolve) => {
    const args = [
      '--no-extensions',
      '-e', governanceExtension,
      '--exclude-tools', 'bash,powershell',
      '--print', prompt,
    ];

    const child = spawn(piPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });

    let stdout = '';
    let stderr = '';
    const MAX_CAPTURE = 2 * 1024 * 1024; // 2MB，防止长输出撑爆内存

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      console.error(`[eag-launch] 无法启动 Pi 进程: ${err.message}`);
      if (spec) writeOutput(spec, `错误: ${err.message}`);
      resolve(1);
    });

    child.on('close', (code) => {
      const exitCode = code ?? 0;
      if (stderr.trim()) console.error(`[eag-launch] ${stderr.trim()}`);

      if (spec) {
        const content = stdout.trim() || (exitCode === 0
          ? ''
          : `任务执行失败（退出码 ${exitCode}）\n${stderr.trim()}`);
        writeOutput(spec, content);
      } else {
        process.stdout.write(stdout);
      }

      resolve(exitCode);
    });
  });
}

// ── 8. 主流程 ────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: LaunchArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[eag-launch] 参数解析失败: ${(err as Error).message}`);
    process.exit(2);
  }

  console.error('[eag-launch] 配置摘要');
  console.error(`  userId:            ${userId}`);
  console.error(`  agentDir:          ${agentDir}`);
  console.error(`  治理扩展路径:        ${governanceExtension}`);
  console.error(`  Pi 路径:            ${piPath}`);
  console.error(`  EAG_ROOT:          ${eagRoot}`);

  // 批处理模式：--task 优先
  if (args.task) {
    const spec = args.task;
    if (!spec.outputLocation) {
      console.error('[eag-launch] --task 缺少 outputLocation');
      process.exit(2);
    }
    console.error(`  taskId:            ${spec.taskId}`);
    console.error(`  outputLocation:    ${spec.outputLocation}`);
    const code = await runBatch(buildPrompt(spec), spec);
    process.exit(code);
  }

  // 一次性命令模式
  if (args.print !== undefined) {
    process.exit(await runBatch(args.print));
  }

  // 交互模式（兼容旧行为）
  const child = spawn(piPath, [
    '--no-extensions',
    '-e', governanceExtension,
    '--exclude-tools', 'bash,powershell',
  ], {
    stdio: 'inherit',
    env: childEnv,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[eag-launch] Pi 子进程被信号 ${signal} 终止`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    console.error(`[eag-launch] 无法启动 Pi 进程: ${err.message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(`[eag-launch] 未预期错误: ${(err as Error).message}`);
  process.exit(1);
});
