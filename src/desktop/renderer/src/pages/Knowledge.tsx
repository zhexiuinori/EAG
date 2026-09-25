import { useCallback, useEffect, useState } from "react";
import * as ipc from "../lib/ipc.ts";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import EmptyState from "../components/EmptyState.tsx";
import { Modal, ConfirmModal } from "../components/Modal.tsx";
import { useToast } from "../components/Toast.tsx";
import { IconPlus, IconList, IconSearch, IconTrash, IconBook } from "../components/icons.tsx";
import type {
  KnowledgeCollection, KnowledgeDetailResult, KnowledgeHit,
} from "@shared/types.ts";

/**
 * 知识库（RAG）。
 *
 * 向量化走配置的 Embedding Provider（设置 → 知识库），检索结果附带来源与
 * 相似度，便于验证"模型到底依据了什么"。摄取与检索都写入审计。
 */
export default function Knowledge() {
  const toast = useToast();
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeDetailResult | null>(null);
  const [loading, setLoading] = useState(true);

  const [kbEditor, setKbEditor] = useState<{ id?: string; name: string; description: string } | null>(null);
  const [docEditor, setDocEditor] = useState<{ title: string; text: string; path: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDeleteKb, setPendingDeleteKb] = useState<KnowledgeCollection | null>(null);
  const [pendingDeleteDoc, setPendingDeleteDoc] = useState<{ id: string; title: string } | null>(null);

  // 检索测试
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await ipc.knowledgeList();
      setCollections(r.collections ?? []);
      return r.collections ?? [];
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      setDetail(await ipc.knowledgeDetail({ id }));
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (active) void refreshDetail(active);
    else setDetail(null);
  }, [active, refreshDetail]);

  const saveKb = () => {
    if (!kbEditor || !kbEditor.name.trim()) return;
    setSaving(true);
    ipc.knowledgeUpsert({ id: kbEditor.id, name: kbEditor.name.trim(), description: kbEditor.description.trim() || undefined })
      .then(async (c) => {
        toast.success(kbEditor.id ? "知识库已更新" : "知识库已创建");
        setKbEditor(null);
        await refresh();
        setActive(c.id);
      })
      .catch((e) => toast.error(`保存失败：${e}`))
      .finally(() => setSaving(false));
  };

  const saveDoc = () => {
    if (!docEditor || !active) return;
    if (!docEditor.text.trim() && !docEditor.path.trim()) return;
    setSaving(true);
    ipc.knowledgeIngest({
      collectionId: active,
      title: docEditor.title.trim() || undefined,
      text: docEditor.text.trim() || undefined,
      path: docEditor.path.trim() || undefined,
    })
      .then(async (r) => {
        if (!r.ok) {
          toast.error(`摄取失败：${r.error ?? "未知错误"}`);
          return;
        }
        toast.success(`已摄取 ${r.chunks} 个分块`);
        setDocEditor(null);
        await refresh();
        await refreshDetail(active);
      })
      .catch((e) => toast.error(`摄取失败：${e}`))
      .finally(() => setSaving(false));
  };

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const r = await ipc.knowledgeSearch({ collectionId: active ?? undefined, query: query.trim(), topK: 5 });
      setHits(r.hits ?? []);
      if (r.error) setSearchError(r.error);
    } catch (e) {
      setSearchError(String(e));
      setHits([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <PageShell
      title="知识库"
      description="文档向量化后按相关性注入对话（RAG）"
      scroll={false}
    >
      <div className="flex flex-col h-full gap-4 min-h-0">
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
          {/* 左：集合列表 */}
          <div className="card flex flex-col min-h-0 overflow-hidden">
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-line">
              <h2 className="text-[12.5px] font-semibold text-fg-muted">知识库</h2>
              <Button size="sm" icon={<IconPlus size={12} />} onClick={() => setKbEditor({ name: "", description: "" })}>
                新建
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <p className="px-4 py-6 text-center text-[11.5px] text-fg-faint">加载中…</p>
              ) : collections.length === 0 ? (
                <EmptyState compact icon={<IconBook size={16} />} title="还没有知识库" description="新建后添加文档，即可挂载给 Worker。" />
              ) : (
                collections.map((c, i) => (
                  <button
                    key={c.id}
                    onClick={() => setActive(c.id)}
                    className={`w-full text-left px-4 py-2.5 transition-colors ${i > 0 ? "border-t border-line" : ""} ${
                      active === c.id ? "bg-primary-bg/50" : "hover:bg-n-850/60"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-[12.5px] truncate ${active === c.id ? "text-fg" : "text-fg-muted"}`}>{c.name}</span>
                    </div>
                    <div className="text-[10.5px] text-fg-faint mt-0.5">
                      {c.docCount} 文档 · {c.chunkCount} 分块
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 右：详情 / 检索 */}
          <div className="flex flex-col min-h-0 gap-4">
            {!active ? (
              <div className="card flex-1 flex items-center justify-center">
                <EmptyState icon={<IconBook size={18} />} title="选择一个知识库" description="查看文档、摄取新内容并测试检索效果。" />
              </div>
            ) : (
              <>
                {/* 检索测试 */}
                <div className="shrink-0 card p-4">
                  <div className="flex items-center gap-2 mb-2.5">
                    <IconSearch size={13} className="text-fg-faint" />
                    <h2 className="text-[12.5px] font-semibold text-fg-muted">检索测试</h2>
                    <span className="text-[10.5px] text-fg-faint">（Agent 对话时会自动做同样的检索）</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void runSearch()}
                      placeholder="输入用户可能问的问题，看会命中哪些片段…"
                      className="field flex-1"
                    />
                    <Button variant="primary" onClick={() => void runSearch()} disabled={searching || !query.trim()}>
                      {searching ? "检索中…" : "检索"}
                    </Button>
                  </div>

                  {searchError && (
                    <div className="mt-2.5 px-3 py-2 rounded-lg bg-red-bg border border-red/30 text-[11px] text-red">
                      {searchError}
                    </div>
                  )}

                  {hits && hits.length > 0 && (
                    <div className="mt-3 space-y-2 max-h-56 overflow-y-auto">
                      {hits.map((h, i) => (
                        <div key={i} className="px-3 py-2 rounded-lg border border-line bg-n-900/40">
                          <div className="flex items-center gap-2 text-[10px] text-fg-faint">
                            <span className="text-primary font-mono">{h.score.toFixed(3)}</span>
                            <span>{h.collectionName}</span>
                            <span>·</span>
                            <span className="truncate">{h.docTitle}</span>
                          </div>
                          <p className="mt-1 text-[11.5px] text-fg-muted leading-relaxed line-clamp-4 whitespace-pre-wrap">{h.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {hits && hits.length === 0 && !searchError && (
                    <p className="mt-2.5 text-[11px] text-fg-faint">没有命中（0 条）。</p>
                  )}
                </div>

                {/* 文档列表 */}
                <div className="flex-1 min-h-0 card flex flex-col overflow-hidden">
                  <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-line">
                    <div className="flex items-center gap-2 min-w-0">
                      <IconList size={13} className="text-fg-faint shrink-0" />
                      <h2 className="text-[12.5px] font-semibold text-fg-muted truncate">
                        {detail?.collection.name ?? "…"}
                      </h2>
                      <span className="text-[10.5px] text-fg-faint shrink-0">
                        {detail?.docs.length ?? 0} 文档 / {detail?.collection.chunkCount ?? 0} 分块
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button size="sm" icon={<IconPlus size={12} />} onClick={() => setDocEditor({ title: "", text: "", path: "" })}>
                        添加文档
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setKbEditor({ id: detail?.collection.id, name: detail?.collection.name ?? "", description: detail?.collection.description ?? "" })}>
                        重命名
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => pendingDeleteKbCheck()}>
                        删除
                      </Button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {(detail?.docs.length ?? 0) === 0 ? (
                      <EmptyState compact icon={<IconList size={16} />} title="还没有文档" description="添加文本文档或指定本地文件路径，自动分块并向量化。" />
                    ) : (
                      detail?.docs.map((d, i) => (
                        <div key={d.id} className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? "border-t border-line" : ""}`}>
                          <div className="min-w-0 flex-1">
                            <div className="text-[12.5px] text-fg-muted truncate">{d.title}</div>
                            <div className="text-[10.5px] text-fg-faint truncate">
                              {d.chunks} 分块{d.source ? ` · ${d.source}` : ""}
                            </div>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => setPendingDeleteDoc({ id: d.id, title: d.title })}>
                            删除
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 新建/编辑知识库 */}
      <Modal
        open={kbEditor !== null}
        title={kbEditor?.id ? "编辑知识库" : "新建知识库"}
        onClose={() => setKbEditor(null)}
        widthClass="max-w-md"
        footer={
          <>
            <Button onClick={() => setKbEditor(null)}>取消</Button>
            <Button variant="primary" onClick={saveKb} disabled={saving || !kbEditor?.name.trim()}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">名称</label>
            <input
              autoFocus
              value={kbEditor?.name ?? ""}
              onChange={(e) => setKbEditor((p) => (p ? { ...p, name: e.target.value } : p))}
              placeholder="例如：产品文档"
              className="field"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">描述（可选）</label>
            <input
              value={kbEditor?.description ?? ""}
              onChange={(e) => setKbEditor((p) => (p ? { ...p, description: e.target.value } : p))}
              placeholder="这个知识库收录什么"
              className="field"
            />
          </div>
        </div>
      </Modal>

      {/* 添加文档 */}
      <Modal
        open={docEditor !== null}
        title="添加文档"
        onClose={() => setDocEditor(null)}
        widthClass="max-w-lg"
        footer={
          <>
            <Button onClick={() => setDocEditor(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={saveDoc}
              disabled={saving || (!docEditor?.text.trim() && !docEditor?.path.trim())}
            >
              {saving ? "摄取中…" : "摄取"}
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">标题（可选）</label>
            <input
              autoFocus
              value={docEditor?.title ?? ""}
              onChange={(e) => setDocEditor((p) => (p ? { ...p, title: e.target.value } : p))}
              placeholder="留空则用文件名"
              className="field"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">
              本地文件路径（与下面文本二选一）
            </label>
            <input
              value={docEditor?.path ?? ""}
              onChange={(e) => setDocEditor((p) => (p ? { ...p, path: e.target.value } : p))}
              placeholder="D:\docs\guide.md"
              className="field font-mono"
            />
          </div>
          <div>
            <label className="block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint mb-1.5">或直接粘贴文本</label>
            <textarea
              value={docEditor?.text ?? ""}
              onChange={(e) => setDocEditor((p) => (p ? { ...p, text: e.target.value } : p))}
              rows={6}
              placeholder="粘贴要收录的内容…"
              className="field resize-none"
            />
          </div>
          <p className="text-[10.5px] text-fg-faint">
            摄取会调用 Embedding Provider 向量化（需先在「设置 → 知识库」配置）。
          </p>
        </div>
      </Modal>

      {/* 删除确认 */}
      <ConfirmModal
        open={pendingDeleteKb !== null}
        title="删除该知识库？"
        description={`「${pendingDeleteKb?.name ?? ""}」及其全部文档与向量将被移除，挂载它的 Worker 将不再检索。`}
        confirmText="删除"
        danger
        onCancel={() => setPendingDeleteKb(null)}
        onConfirm={async () => {
          if (!pendingDeleteKb) return;
          try {
            await ipc.knowledgeDelete({ id: pendingDeleteKb.id });
            toast.success("已删除");
            setPendingDeleteKb(null);
            if (active === pendingDeleteKb.id) setActive(null);
            await refresh();
          } catch (e) {
            toast.error(`删除失败：${e}`);
          }
        }}
      />
      <ConfirmModal
        open={pendingDeleteDoc !== null}
        title="删除该文档？"
        description={`「${pendingDeleteDoc?.title ?? ""}」的所有分块将被移除。`}
        confirmText="删除"
        danger
        onCancel={() => setPendingDeleteDoc(null)}
        onConfirm={async () => {
          if (!pendingDeleteDoc || !active) return;
          try {
            await ipc.knowledgeDocDelete({ collectionId: active, docId: pendingDeleteDoc.id });
            toast.success("文档已删除");
            setPendingDeleteDoc(null);
            await refresh();
            await refreshDetail(active);
          } catch (e) {
            toast.error(`删除失败：${e}`);
          }
        }}
      />
    </PageShell>
  );

  function pendingDeleteKbCheck() {
    if (!detail) return;
    setPendingDeleteKb(collections.find((c) => c.id === detail.collection.id) ?? {
      ...detail.collection,
    });
  }
}
