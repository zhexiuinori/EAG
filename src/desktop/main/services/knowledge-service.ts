// ---------------------------------------------------------------------------
// EAG — 知识库（RAG）
//
// 设计取舍：
//   · 向量化走 **API**（复用已配的 ModelProvider 的 baseUrl + apiKey），
//     不引入本地模型/独立密钥体系 —— 与平台的 provider 治理保持一致。
//   · 存储用文件（<root>/.eag/knowledge/<collectionId>.json），不引数据库。
//   · 检索为余弦相似度 top-k；未配置 embedding 时**明确报错**，不静默返回
//     假结果（治理平台宁可显式失败，也不给不可信的知识）。
//   · 摄取 / 检索写入审计，知识来源可追溯。
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { KNOWLEDGE_DIR } from "../paths.ts";
import * as configApi from "./config-api.ts";
import * as auditApi from "./audit-api.ts";
import type {
  KnowledgeCollection, KnowledgeDetailResult, KnowledgeDocMeta, KnowledgeHit,
  KnowledgeIngestInput, KnowledgeIngestResult, KnowledgeSearchInput, KnowledgeSearchResult,
  KnowledgeUpsertInput,
} from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

interface StoredChunk { text: string; embedding: number[] }
interface StoredDoc extends KnowledgeDocMeta { items: StoredChunk[] }
interface StoredCollection {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  docs: StoredDoc[];
}

function fileOf(id: string): string {
  // id 只由本模块生成（kn-xxx），此处再做一次白名单防止路径穿越
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(KNOWLEDGE_DIR, `${safe}.json`);
}

function read(id: string): StoredCollection | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), "utf-8")) as StoredCollection;
  } catch {
    return null;
  }
}

function write(c: StoredCollection): void {
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  fs.writeFileSync(fileOf(c.id), JSON.stringify(c), "utf-8");
}

function listRaw(): StoredCollection[] {
  try {
    return fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => read(f.replace(/\.json$/, "")))
      .filter((c): c is StoredCollection => c !== null);
  } catch {
    return [];
  }
}

function toMeta(c: StoredCollection): KnowledgeCollection {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    docCount: c.docs.length,
    chunkCount: c.docs.reduce((n, d) => n + d.items.length, 0),
  };
}

// ---------------------------------------------------------------------------
// 集合管理
// ---------------------------------------------------------------------------

export function listCollections(): KnowledgeCollection[] {
  return listRaw().map(toMeta).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function upsertCollection(input: KnowledgeUpsertInput): KnowledgeCollection {
  const now = new Date().toISOString();
  if (input.id) {
    const cur = read(input.id);
    if (cur) {
      cur.name = input.name;
      cur.description = input.description;
      cur.updatedAt = now;
      write(cur);
      return toMeta(cur);
    }
  }
  const c: StoredCollection = {
    id: `kn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: input.name,
    description: input.description,
    createdAt: now,
    updatedAt: now,
    docs: [],
  };
  write(c);
  return toMeta(c);
}

export function deleteCollection(id: string): boolean {
  try {
    fs.unlinkSync(fileOf(id));
    return true;
  } catch {
    return false;
  }
}

export function getDetail(id: string): KnowledgeDetailResult | undefined {
  const c = read(id);
  if (!c) return undefined;
  return {
    collection: toMeta(c),
    docs: c.docs.map((d) => ({
      id: d.id, title: d.title, source: d.source, chunks: d.items.length, createdAt: d.createdAt,
    })),
  };
}

export function deleteDoc(collectionId: string, docId: string): boolean {
  const c = read(collectionId);
  if (!c) return false;
  const next = c.docs.filter((d) => d.id !== docId);
  if (next.length === c.docs.length) return false;
  c.docs = next;
  c.updatedAt = new Date().toISOString();
  write(c);
  return true;
}

// ---------------------------------------------------------------------------
// Embedding（API）
// ---------------------------------------------------------------------------

/** 单次请求最多提交的分块数（避免超长 body）。 */
const EMBED_BATCH = 16;

async function embedTexts(texts: string[]): Promise<number[][]> {
  const cfg = configApi.getConfig();
  const emb = cfg.embedding;
  if (!emb?.providerId || !emb?.model) {
    throw new Error("未配置 Embedding（设置 → 知识库：选择 Provider 与 embedding 模型）");
  }
  const provider = cfg.providers.find((p) => p.id === emb.providerId);
  if (!provider) throw new Error(`Embedding Provider「${emb.providerId}」不存在`);

  const base = provider.baseUrl.replace(/\/+$/, "");
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);

    if (provider.type === "ollama") {
      // Ollama: POST /api/embed { model, input: [...] } → { embeddings: [[...]] }
      const res = await fetch(`${base}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: emb.model, input: batch }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Embedding 失败 HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = await res.json() as { embeddings?: number[][] };
      if (!data.embeddings?.length) throw new Error("Embedding 返回为空（模型名是否正确？）");
      out.push(...data.embeddings);
    } else {
      // OpenAI 兼容: POST /embeddings { model, input: [...] } → { data: [{ embedding }] }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: emb.model, input: batch }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Embedding 失败 HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = await res.json() as { data?: Array<{ embedding: number[] }> };
      if (!data.data?.length) throw new Error("Embedding 返回为空（模型名是否正确？）");
      out.push(...data.data.map((d) => d.embedding));
    }
  }

  return out;
}

/** Embedding 是否已配置（前端据此提示）。 */
export function embeddingConfigured(): boolean {
  const emb = configApi.getConfig().embedding;
  return !!(emb?.providerId && emb?.model);
}

// ---------------------------------------------------------------------------
// 分块
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 80;

/** 按段落聚合到 ~CHUNK_SIZE，尾窗重叠，尽量不切断语义段落。 */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";

  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };

  for (const p of paragraphs) {
    // 超长段落：先按定长切开
    if (p.length > CHUNK_SIZE) {
      flush();
      let i = 0;
      while (i < p.length) {
        chunks.push(p.slice(i, i + CHUNK_SIZE));
        i += CHUNK_SIZE - CHUNK_OVERLAP;
      }
      continue;
    }
    if ((cur + "\n\n" + p).length > CHUNK_SIZE) {
      flush();
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// 摄取
// ---------------------------------------------------------------------------

export async function ingest(
  input: KnowledgeIngestInput,
  operatorId = "console",
): Promise<KnowledgeIngestResult> {
  const c = read(input.collectionId);
  if (!c) return { ok: false, error: `知识库「${input.collectionId}」不存在` };

  let text = input.text ?? "";
  const source = input.path;
  if (!text && input.path) {
    try {
      text = fs.readFileSync(input.path, "utf-8");
    } catch (e: any) {
      return { ok: false, error: `读取文件失败：${e?.message ?? e}` };
    }
  }
  if (!text.trim()) return { ok: false, error: "没有可摄取的内容（text / path 至少提供一个）" };

  const pieces = chunkText(text);
  if (pieces.length === 0) return { ok: false, error: "内容为空" };

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(pieces);
  } catch (e: any) {
    const err = e?.message ?? String(e);
    auditApi.appendAuditEntry({
      userId: operatorId, workerId: undefined, toolName: "__knowledge_ingest",
      toolCallId: undefined, phase: "call",
      input: { collectionId: c.id, title: input.title ?? source, chunks: pieces.length },
      isError: true, reason: err,
    });
    return { ok: false, error: err };
  }

  const doc: StoredDoc = {
    id: `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: input.title || (source ? path.basename(source) : `文档 ${c.docs.length + 1}`),
    source,
    chunks: pieces.length,
    createdAt: new Date().toISOString(),
    items: pieces.map((t, i) => ({ text: t, embedding: embeddings[i] ?? [] })),
  };

  c.docs.push(doc);
  c.updatedAt = new Date().toISOString();
  write(c);

  auditApi.appendAuditEntry({
    userId: operatorId, workerId: undefined, toolName: "__knowledge_ingest",
    toolCallId: undefined, phase: "call",
    input: { collectionId: c.id, docId: doc.id, title: doc.title, source, chunks: pieces.length },
  });

  return { ok: true, docId: doc.id, chunks: pieces.length };
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function search(
  input: KnowledgeSearchInput,
  operatorId = "console",
): Promise<KnowledgeSearchResult> {
  const query = input.query?.trim();
  if (!query) return { hits: [], error: "查询为空" };

  const collections = input.collectionId
    ? [read(input.collectionId)].filter((c): c is StoredCollection => c !== null)
    : listRaw();
  if (collections.length === 0) return { hits: [] };

  let qv: number[];
  try {
    const [v] = await embedTexts([query]);
    qv = v;
  } catch (e: any) {
    // 检索失败必须显式暴露（否则 Agent 会以为"知识库里没有"）
    return { hits: [], error: e?.message ?? String(e) };
  }

  const topK = Math.max(1, Math.min(input.topK ?? 4, 12));
  const all: Array<KnowledgeHit> = [];

  for (const c of collections) {
    for (const d of c.docs) {
      for (const it of d.items) {
        all.push({
          collectionId: c.id,
          collectionName: c.name,
          docTitle: d.title,
          text: it.text,
          score: cosine(qv, it.embedding),
        });
      }
    }
  }

  all.sort((a, b) => b.score - a.score);
  const hits = all.slice(0, topK);

  auditApi.appendAuditEntry({
    userId: operatorId, workerId: undefined, toolName: "__knowledge_search",
    toolCallId: undefined, phase: "call",
    input: {
      query: query.slice(0, 300),
      collections: collections.map((c) => c.id),
      topK,
    },
    content: hits.length ? hits.map((h) => `${h.collectionName}/${h.docTitle} (${h.score.toFixed(3)})`).join("; ") : "无命中",
  });

  return { hits };
}

// ---------------------------------------------------------------------------
// 对话注入用：把命中片段拼成可读的上下文块
// ---------------------------------------------------------------------------

export async function buildContext(
  query: string,
  collectionIds: string[],
  topK = 4,
): Promise<string | undefined> {
  const ids = collectionIds.filter(Boolean);
  if (ids.length === 0 || !query.trim()) return undefined;
  if (!embeddingConfigured()) return undefined;

  const hits: KnowledgeHit[] = [];
  const perKb = Math.max(1, Math.ceil(topK / ids.length));
  for (const id of ids) {
    try {
      const r = await search({ collectionId: id, query, topK: perKb }, "system");
      hits.push(...r.hits);
    } catch {
      // 单个知识库失败不影响其他
    }
  }
  if (hits.length === 0) return undefined;

  return hits
    .map((h, i) => `[${i + 1}] (${h.collectionName} · ${h.docTitle})\n${h.text}`)
    .join("\n\n---\n\n");
}
