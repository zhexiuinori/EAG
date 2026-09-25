/**
 * task-decomposer — 任务拆解器
 *
 * 将用户请求分析并拆解为可并行/串行执行的原子任务列表。
 *
 * 当前 MVP 阶段使用基于关键词的静态拆分策略（不调用 LLM），
 * 演示任务分解、DAG 构建、outputLocation 分配的完整流程。
 * 后续可替换为 LLM-based 的动态拆解。
 */

import type { AtomicTask, UserRequest } from "./types.ts";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
// swarm 在主进程内执行，与 Agent 引擎共用同一套 Provider 配置（不引第二套密钥）
import * as configApi from "../desktop/main/services/config-api.ts";

// ---------------------------------------------------------------------------
// Static decomposition strategies (MVP)
// ---------------------------------------------------------------------------

/**
 * Known task patterns and their decomposition rules.
 * Extend this map to support more task types.
 */
interface DecompositionRule {
  subtasks: Array<{
    title: string;
    description: string;
    dependsOnIndex: number[]; // indices into subtasks array
  }>;
}

const DECOMPOSITION_PATTERNS: Array<{
  keywords: string[];
  rule: DecompositionRule;
}> = [
  {
    keywords: ["review", "审查", "审计", "audit", "code review"],
    rule: {
      subtasks: [
        {
          title: "Code Analysis",
          description: "Analyze the codebase structure and identify key modules",
          dependsOnIndex: [],
        },
        {
          title: "Security Review",
          description: "Check for security vulnerabilities and bad practices",
          dependsOnIndex: [0],
        },
        {
          title: "Quality Assessment",
          description: "Assess code quality, test coverage, documentation",
          dependsOnIndex: [0],
        },
        {
          title: "Summary Report",
          description: "Compile findings into a structured report",
          dependsOnIndex: [1, 2],
        },
      ],
    },
  },
  {
    keywords: ["research", "调研", "研究", "investigate", "分析"],
    rule: {
      subtasks: [
        {
          title: "Architecture Overview",
          description: "Understand the project architecture and components",
          dependsOnIndex: [],
        },
        {
          title: "Feature Deep Dive",
          description: "Detailed analysis of key features",
          dependsOnIndex: [0],
        },
        {
          title: "Risk Assessment",
          description: "Identify potential risks and limitations",
          dependsOnIndex: [0],
        },
        {
          title: "Synthesis",
          description: "Combine findings into a comprehensive report",
          dependsOnIndex: [1, 2],
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Default decomposition (for unrecognized requests)
// ---------------------------------------------------------------------------

const DEFAULT_RULE: DecompositionRule = {
  subtasks: [
    {
      title: "Requirement Analysis",
      description: "Analyze the user request and define scope",
      dependsOnIndex: [],
    },
    {
      title: "Execution",
      description: "Execute the primary task",
      dependsOnIndex: [0],
    },
    {
      title: "Verification",
      description: "Verify the execution result",
      dependsOnIndex: [1],
    },
  ],
};

// ---------------------------------------------------------------------------
// Task ID generation
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function matchRule(prompt: string): DecompositionRule {
  const lower = prompt.toLowerCase();
  for (const pattern of DECOMPOSITION_PATTERNS) {
    if (pattern.keywords.some((kw) => lower.includes(kw))) {
      return pattern.rule;
    }
  }
  return DEFAULT_RULE;
}

// ---------------------------------------------------------------------------
// Output location
// ---------------------------------------------------------------------------

/**
 * Generate an output location path for a task.
 * Uses EAG_SWARM_OUTPUT_DIR or falls back to a temp directory.
 */
function getOutputDir(): string {
  // 原实现硬编码 POSIX 的 /tmp，在 Windows 上该目录不存在
  return process.env.EAG_SWARM_OUTPUT_DIR || path.join(os.tmpdir(), "eag-swarm");
}

function generateOutputLocation(taskId: string): string {
  return path.join(getOutputDir(), `${taskId}.json`);
}

// ---------------------------------------------------------------------------
// Topological sort the tasks by dependsOn
// ---------------------------------------------------------------------------

function topologicalSort(tasks: AtomicTask[]): AtomicTask[] {
  const visited = new Set<string>();
  const sorted: AtomicTask[] = [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  function visit(id: string, path: Set<string>) {
    if (visited.has(id)) return;
    if (path.has(id)) {
      // Cycle detected — break by adding anyway
      visited.add(id);
      sorted.push(taskMap.get(id)!);
      return;
    }
    path.add(id);
    const task = taskMap.get(id);
    if (task) {
      for (const depId of task.dependsOn) {
        visit(depId, path);
      }
      visited.add(id);
      sorted.push(task);
    }
    path.delete(id);
  }

  for (const task of tasks) {
    visit(task.id, new Set());
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decompose a user request into atomic tasks with DAG dependencies.
 *
 * @param request - The user request to decompose
 * @returns AtomicTask[] with properly assigned IDs, output locations, and DAG
 */
export function decompose(request: UserRequest): AtomicTask[] {
  const rule = matchRule(request.prompt);
  return materialize(
    rule.subtasks.map((sub) => ({
      title: sub.title,
      description: sub.description,
      dependsOnIndex: sub.dependsOnIndex,
    })),
    request,
  );
}

/** 把 {title, description, dependsOn} 规范化成 AtomicTask[]（分配 id / 输出位置 / 拓扑序）。 */
function materialize(
  items: Array<{ title: string; description: string; dependsOnIndex: number[] }>,
  request: UserRequest,
): AtomicTask[] {
  const idMap = new Map<number, string>();
  const partial = items.map((t, index) => {
    const id = generateId();
    idMap.set(index, id);
    return {
      id,
      title: t.title,
      description: t.description,
      input: { prompt: request.prompt },
      outputLocation: "",
      dependsOnIndex: t.dependsOnIndex,
    };
  });

  const tasks: AtomicTask[] = partial.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    input: t.input,
    outputLocation: generateOutputLocation(t.id),
    dependsOn: t.dependsOnIndex
      .filter((i) => idMap.has(i))
      .map((i) => idMap.get(i)!),
  }));

  return topologicalSort(tasks);
}

// ---------------------------------------------------------------------------
// LLM 拆解（优先），规则式兜底
// ---------------------------------------------------------------------------

/** 从模型输出里稳健地取出 JSON（容忍 markdown 围栏与前后解释文字）。 */
function extractJson(text: string): any | null {
  const trimmed = (text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 用模型把请求拆成原子任务。
 *
 * 返回 null 表示"拆不动"（未配置 provider / 网络失败 / 输出不是合法 JSON），
 * 调用方应回退到规则式 decompose —— 蜂群不能因为模型不可用就整体跑不起来。
 *
 * 说明：这里直接读 config-api 的 Provider 配置（swarm 在主进程内执行，
 * 与 Agent 引擎共用同一套模型配置，不引入第二套密钥）。
 */
export async function decomposeWithLLM(request: UserRequest): Promise<AtomicTask[] | null> {
  let baseUrl = "";
  let apiKey: string | undefined;
  let model = "";
  let isOllama = false;

  try {
    const cfg = configApi.getConfig();
    const p = cfg.providers.find((x) => x.id === cfg.activeProviderId) ?? cfg.providers[0];
    if (!p?.baseUrl) return null;
    baseUrl = p.baseUrl.replace(/\/+$/, "");
    apiKey = p.apiKey;
    model = p.activeModel || p.models?.[0] || "";
    isOllama = p.type === "ollama";
    if (!model) return null;
  } catch {
    return null;
  }

  const system = [
    "你是任务拆解器。把用户的请求拆成 2-6 个可独立执行的原子任务（请求确实简单时，1 个任务即可）。",
    "要求：",
    "- 每个任务有明确可验证的产出（写入文件或给出结论）",
    "- 用 dependsOn 表达依赖：数组，元素是前置任务的下标（从 0 开始）；无依赖用 []",
    "- 只输出 JSON，不要任何解释文字",
    '格式：{"tasks":[{"title":"简短标题","description":"做什么、产出什么","dependsOn":[]}]}',
  ].join("\n");

  const userContent = request.context
    ? `${request.prompt}\n\n附加上下文：\n${request.context}`
    : request.prompt;

  let text = "";
  try {
    const url = isOllama ? `${baseUrl}/v1/chat/completions` : `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    text = data?.choices?.[0]?.message?.content ?? "";
  } catch {
    return null;
  }

  const parsed = extractJson(text);
  const raw = Array.isArray(parsed?.tasks) ? parsed.tasks : null;
  if (!raw || raw.length === 0) return null;

  const items = raw
    .filter((t: any) => t && typeof t.title === "string" && t.title.trim())
    .slice(0, 8)
    .map((t: any) => ({
      title: String(t.title).trim().slice(0, 120),
      description: String(t.description ?? "").trim().slice(0, 1000) || String(t.title).trim(),
      dependsOnIndex: Array.isArray(t.dependsOn)
        ? t.dependsOn.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n >= 0)
        : [],
    }));

  if (items.length === 0) return null;
  return materialize(items, request);
}
