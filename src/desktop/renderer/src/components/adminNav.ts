import type { ComponentType } from "react";
import {
  IconWorkspace, IconNetwork, IconSliders, IconList, IconShield, IconUsers,
  IconInbox, IconGauge, IconBook, IconClock,
} from "./icons.tsx";

export interface AdminPage {
  path: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export interface AdminModule {
  key: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  pages: AdminPage[];
}

/**
 * 管理端信息架构（Dolphin 控制台形态）：
 * 顶部 header 居中模块 tab + 左侧当前模块子菜单。
 */
export const ADMIN_MODULES: AdminModule[] = [
  {
    key: "agents",
    label: "智能体管理",
    icon: IconWorkspace,
    pages: [
      { path: "/admin/workers", label: "Workers", icon: IconWorkspace },
      { path: "/admin/swarm", label: "Swarm", icon: IconNetwork },
      { path: "/admin/knowledge", label: "知识库", icon: IconBook },
    ],
  },
  {
    key: "governance",
    label: "治理",
    icon: IconShield,
    pages: [
      { path: "/admin/inbox", label: "审批 Inbox", icon: IconInbox },
      { path: "/admin/governance", label: "治理总览", icon: IconGauge },
      { path: "/admin/audit", label: "审计 Audit", icon: IconList },
      { path: "/admin/policy", label: "策略 Policy", icon: IconShield },
    ],
  },
  {
    key: "resources",
    label: "资源",
    icon: IconSliders,
    pages: [
      { path: "/admin/models", label: "Models", icon: IconSliders },
      { path: "/admin/schedules", label: "定时任务", icon: IconClock },
    ],
  },
  {
    key: "system",
    label: "系统",
    icon: IconUsers,
    pages: [
      { path: "/admin/settings", label: "设置", icon: IconUsers },
    ],
  },
];

/** 当前路径所属的模块；不在任何模块内时返回 null */
export function moduleOfPath(pathname: string): AdminModule | null {
  return ADMIN_MODULES.find((m) => m.pages.some((p) => pathname.startsWith(p.path))) ?? null;
}
