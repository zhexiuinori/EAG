import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import PageShell from "../components/PageShell.tsx";
import Button from "../components/Button.tsx";
import EmptyState from "../components/EmptyState.tsx";
import { useWorkerStore } from "../stores/workerStore.ts";
import {
  IconChat, IconClock, IconWorkspace, IconShield, IconBook, IconPlay,
} from "../components/icons.tsx";

type TabKey = "chat" | "progress" | "files" | "changes" | "usage";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "chat", label: "对话" },
  { key: "progress", label: "进度" },
  { key: "files", label: "文件" },
  { key: "changes", label: "变更" },
  { key: "usage", label: "用量" },
];

/** 占位 tab 的统一呈现：说明定位 + 标注后续接入点（PRD-001 R2 验收要求） */
function PlaceholderTab({ title, note }: { title: string; note: string }) {
  return (
    <div className="card">
      <EmptyState
        icon={<IconWorkspace size={18} />}
        title={title}
        description={`待接入 —— ${note}`}
      />
    </div>
  );
}

/**
 * Agent 工作区壳（PRD-001 R2）：对话 / 进度 / 文件 / 变更 / 用量 五个 tab。
 * 对话复用现有 WorkChat；用量展示卡片已有的配置数据；
 * 进度 / 文件 / 变更为占位实现，接入点见各 PlaceholderTab 的 note。
 */
export default function AgentHome() {
  const { workerId = "" } = useParams();
  const nav = useNavigate();

  const workers = useWorkerStore((s) => s.mine);
  const loaded = useWorkerStore((s) => s.loadedMine);
  const loadMine = useWorkerStore((s) => s.loadMine);

  const [tab, setTab] = useState<TabKey>("chat");

  useEffect(() => { void loadMine(); }, [loadMine]);

  const worker = workers.find((w) => w.id === workerId);

  if (loaded && !worker) {
    return (
      <PageShell title="助手不存在" description="它可能已被移除，或你没有访问权限">
        <div className="card">
          <EmptyState
            icon={<IconWorkspace size={18} />}
            title="找不到这个助手"
            description="返回我的助手列表看看。"
            action={<Button variant="primary" onClick={() => nav("/app")}>返回我的助手</Button>}
          />
        </div>
      </PageShell>
    );
  }

  const running = worker?.status === "running";

  return (
    <PageShell
      title={worker?.name ?? "…"}
      description={worker?.description || undefined}
      actions={
        <Button
          variant="primary"
          icon={<IconChat size={13} />}
          onClick={() => nav(`/app/chat/${workerId}`)}
        >
          进入对话
        </Button>
      }
    >
      <div className="space-y-4 max-w-4xl">
        {/* 状态条：运行状态 / 模型 / 受控标识（PRD-001 T1：用户端只给弱提示） */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="relative flex items-center justify-center shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green" : "bg-n-600"}`} />
            {running && <span className="absolute w-1.5 h-1.5 rounded-full bg-green animate-breathe-soft" />}
          </span>
          <span className="text-[12px] text-fg-subtle">{running ? "运行中" : "空闲"}</span>
          <span className="text-[11px] text-fg-muted">
            模型 · {worker?.config.modelName || "默认"}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-primary-bg text-primary border border-primary-border inline-flex items-center gap-1"
            title="该助手的操作受企业策略保护，被拦截的操作会记录在你的操作记录里"
          >
            <IconShield size={10} />
            受控
          </span>
        </div>

        {/* Tab 导航 */}
        <div className="flex items-center gap-1 border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-[12.5px] rounded-t-lg transition-colors ${
                tab === t.key
                  ? "text-fg font-medium border-b-2 border-primary -mb-px"
                  : "text-fg-subtle hover:text-fg-muted"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab 内容 */}
        {tab === "chat" && (
          <div className="card">
            <EmptyState
              icon={<IconChat size={18} />}
              title="开始对话"
              description="对话在专属聊天页进行，支持流式回复、工具卡片与附件。"
              action={
                <Button variant="primary" onClick={() => nav(`/app/chat/${workerId}`)}>
                  进入对话
                </Button>
              }
            />
          </div>
        )}

        {tab === "progress" && (
          <PlaceholderTab
            title="正在做什么"
            note="接入点为执行总线 / Swarm 时间线（src/swarm/orchestrator.ts），呈现 分析 → 编辑 → 测试 → 完成 的实时进度。"
          />
        )}

        {tab === "files" && (
          <PlaceholderTab
            title="文件"
            note="接入点为 fs-gate 读路径（src/extension/fs-gate.ts）与 FileBrowser 组件，升级为可编辑文件树。"
          />
        )}

        {tab === "changes" && (
          <PlaceholderTab
            title="变更"
            note="接入点为 diff review 服务，呈现 diff 列表与逐文件审查。"
          />
        )}

        {tab === "usage" && worker && (
          <div className="card p-4 space-y-3">
            <div className="flex items-center gap-1.5">
              <IconPlay size={13} className="text-fg-faint" />
              <h3 className="text-[12px] font-semibold text-fg">用量与范围</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
              <div className="rounded-lg border border-line p-3">
                <div className="text-fg-faint text-[10.5px] mb-1">预算上限</div>
                <div className="text-fg">
                  {worker.config.budgetLimitUsd != null ? `$${worker.config.budgetLimitUsd}` : "未设置"}
                </div>
              </div>
              <div className="rounded-lg border border-line p-3">
                <div className="text-fg-faint text-[10.5px] mb-1">可访问范围</div>
                <div className="text-fg">
                  {(worker.assignedGroupIds?.length ?? 0) > 0 ? "团队共享" : worker.type === "personal" ? "个人" : "项目"}
                </div>
              </div>
              <div className="rounded-lg border border-line p-3">
                <div className="text-fg-faint text-[10.5px] mb-1 flex items-center gap-1">
                  <IconBook size={10} />
                  知识库
                </div>
                <div className="text-fg">
                  {(worker.config.knowledgeIds?.length ?? 0) > 0
                    ? `${worker.config.knowledgeIds!.length} 个已挂载`
                    : "未挂载"}
                </div>
              </div>
              <div className="rounded-lg border border-line p-3">
                <div className="text-fg-faint text-[10.5px] mb-1 flex items-center gap-1">
                  <IconClock size={10} />
                  花费明细
                </div>
                <div className="text-fg-subtle">待接入 —— 成本服务（cost.ts）</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}
