import { create } from "zustand";
import * as ipc from "../lib/ipc.ts";
import type { ApprovalRecord } from "@shared/types.ts";

/**
 * 审批状态（参考 QwenPaw 的 Inbox / ApprovalCard）。
 * 主进程通过 approval:event 推送请求与决策结果；页面本身也定时刷新兜底。
 */

interface ApprovalState {
  approvals: ApprovalRecord[];
  loaded: boolean;
  load: () => Promise<void>;
  decide: (id: string, approved: boolean) => Promise<boolean>;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  approvals: [],
  loaded: false,

  load: async () => {
    try {
      const r = await ipc.approvalList();
      set({ approvals: r.approvals ?? [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  decide: async (id, approved) => {
    const ok = await ipc.approvalDecide({ id, approved });
    if (ok) {
      set((s) => ({
        approvals: s.approvals.map((a) =>
          a.id === id
            ? { ...a, status: approved ? ("approved" as const) : ("denied" as const), decidedAt: new Date().toISOString() }
            : a,
        ),
      }));
    }
    return ok;
  },
}));

/** 待决审批数量（顶栏角标用）。 */
export const countPendingApprovals = (list: ApprovalRecord[]): number =>
  list.filter((a) => a.status === "pending").length;

/** 应用启动时接入审批事件流。 */
export function initApprovalEvents(): void {
  ipc.onApprovalEvent((rec) => {
    useApprovalStore.setState((s) => {
      const idx = s.approvals.findIndex((a) => a.id === rec.id);
      if (idx === -1) return { approvals: [rec, ...s.approvals] };
      const next = [...s.approvals];
      next[idx] = rec;
      return { approvals: next };
    });
  });
}
