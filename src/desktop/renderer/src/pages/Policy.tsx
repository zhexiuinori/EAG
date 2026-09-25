import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc.ts";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import { useToast } from "../components/Toast.tsx";
import { IconPlus, IconX, IconGlobe } from "../components/icons.tsx";
import type { PolicyMap, AccessLevel } from "@extension/policy.ts";

const ACCESS_TEXT: Record<AccessLevel, string> = {
  rw: "text-green",
  r: "text-blue",
  hidden: "text-red",
};

export default function Policy() {
  const toast = useToast();
  const [policies, setPolicies] = useState<PolicyMap>([]);
  const [loading, setLoading] = useState(true);
  const [endpoints, setEndpoints] = useState<string[]>([]);

  useEffect(() => {
    ipc.policyGet()
      .then((r) => { setPolicies(r.policies); setLoading(false); })
      .catch((e) => { setLoading(false); toast.error(`策略加载失败：${e}`); });
    ipc.egressWhitelist()
      .then((r) => setEndpoints(r.endpoints ?? []))
      .catch(() => setEndpoints([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updatePath = (i: number, v: string) =>
    setPolicies((p) => p.map((e, j) => (j === i ? { ...e, path: v } : e)));
  const updateAccess = (i: number, v: AccessLevel) =>
    setPolicies((p) => p.map((e, j) => (j === i ? { ...e, access: v } : e)));
  const remove = (i: number) => setPolicies((p) => p.filter((_, j) => j !== i));
  const add = () => setPolicies((p) => [...p, { path: "", access: "hidden" }]);

  const save = async () => {
    try {
      await ipc.policyUpdate({ policies });
      toast.success("策略已保存");
    } catch (e) {
      toast.error(`保存失败：${e}`);
    }
  };

  return (
    <PageShell
      title="Policy"
      description={`全局路径策略 · ${policies.length} 条规则`}
      actions={
        <>
          <Button icon={<IconPlus size={13} />} onClick={add}>添加条目</Button>
          <Button variant="primary" onClick={save}>保存</Button>
        </>
      }
    >
      <div className="card overflow-hidden">
        {loading ? (
          <div className="px-4 py-10 text-center text-[11.5px] text-fg-faint">加载中…</div>
        ) : policies.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-[12.5px] text-fg-muted">还没有任何策略</p>
            <p className="text-[11px] text-fg-faint mt-1">没有匹配条目时默认拒绝一切访问</p>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>路径</th>
                <th className="w-28">访问级别</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {policies.map((e, i) => (
                <tr key={i}>
                  <td className="text-fg-faint tabular-nums">{i + 1}</td>
                  <td>
                    <input
                      value={e.path}
                      onChange={(ev) => updatePath(i, ev.target.value)}
                      placeholder="${PROJECT_ROOT}/path"
                      className="w-full bg-transparent border-b border-transparent focus:border-primary-border text-fg-muted font-mono text-[12px] py-0.5 outline-none transition-colors"
                    />
                  </td>
                  <td>
                    <select
                      value={e.access}
                      onChange={(ev) => updateAccess(i, ev.target.value as AccessLevel)}
                      className={`field w-24 cursor-pointer ${ACCESS_TEXT[e.access]}`}
                    >
                      <option value="rw">rw</option>
                      <option value="r">r</option>
                      <option value="hidden">hidden</option>
                    </select>
                  </td>
                  <td>
                    <button
                      onClick={() => remove(i)}
                      title="删除该条目"
                      className="p-1 rounded text-fg-faint hover:text-red hover:bg-red-bg transition-colors"
                    >
                      <IconX size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-3 text-[10.5px] text-fg-faint leading-relaxed">
        路径支持 <code className="font-mono text-fg-subtle">{"${PROJECT_ROOT}"}</code>、
        <code className="font-mono text-fg-subtle">{"${HOME}"}</code> 等变量。
        这里是全局默认策略；Worker 可追加覆盖条目，二者合并后对三个引擎统一生效。
      </p>

      {/* 出网白名单（此前仅有 API，无任何界面展示） */}
      <section className="mt-7">
        <div className="flex items-center gap-1.5 mb-2.5">
          <IconGlobe size={13} className="text-fg-faint" />
          <h2 className="text-[12.5px] font-semibold text-fg-muted">出网白名单</h2>
          <span className="text-[10.5px] text-fg-faint">{endpoints.length} 个端点</span>
        </div>
        <div className="card overflow-hidden">
          {endpoints.length === 0 ? (
            <p className="px-4 py-4 text-[11.5px] text-fg-faint">
              未配置白名单端点（所有非本地出网请求默认被拒绝）
            </p>
          ) : (
            <div className="divide-y divide-line">
              {endpoints.map((e) => (
                <div key={e} className="px-4 py-2 font-mono text-[11.5px] text-fg-subtle truncate">
                  {e}
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="mt-2 text-[10.5px] text-fg-faint leading-relaxed">
          由治理扩展在运行时校验；开启 <code className="font-mono text-fg-subtle">EAG_EGRESS_ENFORCE</code> 后，
          非白名单端点会被真正阻断（而非仅记录日志）。
        </p>
      </section>
    </PageShell>
  );
}
