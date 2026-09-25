import { useCallback, useEffect, useState } from "react";
import * as ipc from "../lib/ipc.ts";
import type { FileListResult, FileReadResult } from "@shared/types.ts";

/**
 * 受治理的文件工作区。
 *
 * 与常规文件树的区别：列表由服务端过滤——策略判定为 hidden 的条目
 * 根本不会返回，读写也受策略约束并落审计。因此这里"看不到"的文件，
 * 对 Agent 同样不可见，二者保持一致。
 */
export default function FileBrowser() {
  const [cwd, setCwd] = useState<string>("");
  const [listing, setListing] = useState<FileListResult | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileReadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    setOpenPath(null);
    setFile(null);
    setEditing(false);
    try {
      const res = await ipc.fileList({ path: target });
      setListing(res);
      setCwd(res.root);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const openFile = async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await ipc.fileRead({ path: target });
      setFile(res);
      setOpenPath(target);
      setDraft(res.content ?? "");
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!openPath) return;
    setSaving(true);
    setError(null);
    try {
      const res = await ipc.fileWrite({ path: openPath, content: draft });
      if (!res.ok) {
        setError(res.error ?? "保存失败");
      } else {
        setEditing(false);
        await openFile(openPath);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const shortName = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;

  return (
    <div className="text-[11px]">
      {/* 路径导航 */}
      <div className="flex items-center gap-1.5 mb-2">
        {openPath ? (
          <button
            onClick={() => { setOpenPath(null); setFile(null); setEditing(false); }}
            className="px-1.5 py-0.5 rounded bg-n-800 text-n-300 hover:bg-n-700 transition-colors"
          >
            &larr;
          </button>
        ) : listing?.parent ? (
          <button
            onClick={() => loadDir(listing.parent as string)}
            className="px-1.5 py-0.5 rounded bg-n-800 text-n-300 hover:bg-n-700 transition-colors"
          >
            &uarr;
          </button>
        ) : null}
        <span className="font-mono text-n-500 truncate" title={openPath ?? cwd}>
          {openPath ? shortName(openPath) : shortName(cwd) || "项目根"}
        </span>
        {listing?.writable && !openPath && (
          <span className="ml-auto shrink-0 text-[10px] text-green">可写</span>
        )}
      </div>

      {error && (
        <div className="mb-2 px-2 py-1 rounded bg-red-bg border border-red/30 text-red text-[10px]">
          {error}
        </div>
      )}

      {loading && <div className="px-1 py-2 text-n-600">加载中…</div>}

      {/* 文件内容 */}
      {openPath && file && !loading ? (
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              file.access === "rw" ? "bg-green-bg text-green" : "bg-blue-bg text-blue"
            }`}>
              {file.access === "rw" ? "可读写" : "只读"}
            </span>
            {file.access === "rw" && !editing && (
              <button
                onClick={() => setEditing(true)}
                className="px-1.5 py-0.5 rounded text-[10px] bg-n-800 text-n-300 hover:bg-n-700 transition-colors"
              >
                编辑
              </button>
            )}
            {editing && (
              <>
                <button
                  onClick={save}
                  disabled={saving}
                  className="px-1.5 py-0.5 rounded text-[10px] bg-primary-strong text-white hover:bg-primary transition-colors disabled:opacity-50"
                >
                  {saving ? "保存中" : "保存"}
                </button>
                <button
                  onClick={() => { setEditing(false); setDraft(file.content ?? ""); }}
                  className="px-1.5 py-0.5 rounded text-[10px] bg-n-800 text-n-400 hover:bg-n-700 transition-colors"
                >
                  取消
                </button>
              </>
            )}
          </div>

          {file.truncated && (
            <div className="mb-1 text-[10px] text-yellow">文件过大，仅显示前 512 KB</div>
          )}

          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full h-72 px-2 py-1.5 bg-n-950 border border-n-700 rounded-lg text-[10px] font-mono text-n-200 outline-none focus:border-primary-strong resize-none"
            />
          ) : (
            <pre className="max-h-72 overflow-auto bg-n-950 border border-line rounded-lg p-2 font-mono text-[10px] text-n-300 whitespace-pre-wrap break-all">
              {file.content}
            </pre>
          )}
        </div>
      ) : null}

      {/* 目录列表 */}
      {!openPath && listing && !loading ? (
        listing.entries.length === 0 ? (
          <p className="px-1 py-2 text-n-600">该目录无可访问条目（受策略限制或为空）</p>
        ) : (
          <div className="space-y-0.5">
            {listing.entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => (entry.type === "dir" ? loadDir(entry.path) : openFile(entry.path))}
                className="w-full flex items-center gap-2 px-2 py-1 rounded text-left hover:bg-n-800/60 transition-colors"
              >
                <span className={`shrink-0 ${entry.type === "dir" ? "text-blue" : "text-n-600"}`}>
                  {entry.type === "dir" ? "▸" : "·"}
                </span>
                <span className={`truncate ${entry.type === "dir" ? "text-n-200" : "text-n-400"}`}>
                  {entry.name}
                </span>
                {entry.access === "r" && (
                  <span className="ml-auto shrink-0 text-[9px] text-blue">只读</span>
                )}
              </button>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
