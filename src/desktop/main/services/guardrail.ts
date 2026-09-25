// ---------------------------------------------------------------------------
// EAG — 内容护栏（Guardrail）
//
// 检测 Agent 输出里是否含密钥 / 凭证 / PII 等敏感内容，防止它们被外发
// （贴进对话、写入公开文件）。这是治理闭环的"内容护栏"闸门。
//
// 设计原则：
//   · 检测函数是纯函数，不依赖任何运行时 —— 便于直接单测。
//   · 只做"标记"，不替调用方做决策（是否阻断 / 是否仅告警由调用方定）。
//   · 与 snapshot.ts 的敏感文件 pattern 不同：这里是"值"级检测（如 sk-xxx、
//     私钥块、密钥对），瞄准"内容里藏着什么"，而非"哪条路径敏感"。
// ---------------------------------------------------------------------------

export interface GuardrailFinding {
  kind: "api_key" | "private_key" | "credential" | "contact";
  /** 命中样本（脱敏：只保留前 6 位 + 长度，避免把完整密钥再记一遍） */
  sample: string;
}

/** 对命中样本做脱敏，防止审计/日志再泄露一份完整密钥。 */
function maskSample(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return `${v.slice(0, 2)}…`;
  return `${v.slice(0, 6)}…(${v.length} 字符)`;
}

// 常见 API 密钥前缀（OpenAI / Anthropic / 通用 sk- / xox / ghp 等）
const API_KEY_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/g;

// PEM/DSA/OpenSSH 私钥块
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g;

// "password = / password:" 后跟一串明确值（避免误报普通单词 password）
const CREDENTIAL_PATTERN = /(?:password|passwd|pwd|secret|token|api_key|apikey)\s*[:=]\s*["']?([A-Za-z0-9_\-@#$%^&*]{6,})/gi;

// 简略的邮箱 / 手机号（PII）
const CONTACT_PATTERN = /(\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|\b1[3-9]\d{9}\b)/g;

/** 主检测入口：扫描文本，返回命中的敏感类别列表（可能多个）。 */
export function scanSensitive(text: string): GuardrailFinding[] {
  if (!text) return [];
  const findings: GuardrailFinding[] = [];

  for (const m of text.matchAll(API_KEY_PATTERN)) {
    findings.push({ kind: "api_key", sample: maskSample(m[0]) });
  }
  for (const m of text.matchAll(PRIVATE_KEY_PATTERN)) {
    findings.push({ kind: "private_key", sample: maskSample(m[0]) });
  }
  for (const m of text.matchAll(CREDENTIAL_PATTERN)) {
    findings.push({ kind: "credential", sample: maskSample(m[1] ?? m[0]) });
  }
  for (const m of text.matchAll(CONTACT_PATTERN)) {
    findings.push({ kind: "contact", sample: maskSample(m[0]) });
  }

  return findings;
}

/** 文本是否包含任何敏感内容。 */
export function isSensitive(text: string): boolean {
  return scanSensitive(text).length > 0;
}

// ---------------------------------------------------------------------------
// 自检（node --experimental-strip-types 直接跑，或经 tsx）
// 非平凡正则逻辑，留一个最小断言式检查，保证改正则时不破坏关键能力。
// ---------------------------------------------------------------------------

function demo(): void {
  const assert = (label: string, cond: boolean) => {
    if (!cond) {
      console.error(`✗ ${label}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ ${label}`);
    }
  };

  // 应命中
  assert("识别 OpenAI 风格 key", isSensitive("cos 用 sk-abcdefgh1234567890ABCDEF 连的"));
  assert("识别 PEM 私钥块", isSensitive("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"));
  assert("识别 password= 明文凭证", isSensitive("db password=hunter2secret"));
  assert("识别邮箱(PII)", isSensitive("联系 zhangsan@example.com 获取"));

  // 不应误报
  assert("普通单词 password 不误报", !isSensitive("修改了 password 相关逻辑"));
  assert("普通邮件讨论不误报", !isSensitive("我们讨论一下这个功能"));
  assert("不含敏感内容不报", !isSensitive("重构了 Sidebar 组件"));

  // 脱敏：不应把完整 key 留在 sample 里
  const findings = scanSensitive("key is sk-abcdefgh1234567890ABCDEF");
  assert("命中样本已脱敏(不含完整密钥)", findings.every((f) => !f.sample.includes("abcdefgh1234567890ABCDEF")));

  console.log(process.exitCode ? "\n自检失败" : "\n自检通过");
}

// 仅在作为脚本直接运行时执行（不干扰 import）
const isMain = typeof process !== "undefined" && process.argv?.[1]?.includes("guardrail");
if (isMain) demo();

