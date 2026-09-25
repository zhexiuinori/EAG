// ---------------------------------------------------------------------------
// EAG — 极简 .env 加载
//
// 密钥已外置为 ${EAG_API_KEY_*} 占位符，需要把 .env 注入 process.env。
// 这里手写解析而不是引入 dotenv：Electron 主进程与 Express server 共用同一
// 份配置逻辑，少一个运行时依赖就少一处打包问题。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "../paths.ts";

let loaded = false;

/** 已有的环境变量优先，.env 只作为兜底。文件不存在时静默跳过。 */
export function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;

  const envPath = process.env.EAG_ENV_FILE || path.join(PROJECT_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  try {
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    // .env 是可选的，读取失败不应阻断启动
    console.error("[EAG] 读取 .env 失败（已忽略）:", err);
  }
}
