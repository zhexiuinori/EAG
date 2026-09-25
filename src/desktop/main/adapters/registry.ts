// ---------------------------------------------------------------------------
// EAG — Agent adapter registry
//
// Maps AgentKind → adapter instance. worker-service is the only consumer;
// it resolves a worker's engine here and never touches agent-specific code.
// ---------------------------------------------------------------------------

import type { AgentKind, AdapterStatus } from "../../shared/types.ts";
import type { AgentAdapter } from "./types.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import { piAdapter } from "./pi.ts";

const ADAPTERS: Partial<Record<AgentKind, AgentAdapter>> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  pi: piAdapter,
};

export function getAdapter(kind: AgentKind): AgentAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) {
    const registered = Object.keys(ADAPTERS).join(", ") || "none";
    throw new Error(
      `Agent kind "${kind}" 未注册 adapter（已注册: ${registered}）。` +
      `若要接入该引擎，请见 docs/接入Agent引擎-adapter开发指南.md 实现并注册。`,
    );
  }
  return adapter;
}

export function isAdapterAvailable(kind: AgentKind): boolean {
  return kind in ADAPTERS;
}

/** Live status of all registered adapters (for the admin UI). */
export async function listAdapterStatus(): Promise<AdapterStatus[]> {
  const entries = Object.values(ADAPTERS) as AgentAdapter[];
  return Promise.all(entries.map(async (adapter) => {
    const det = await adapter.detect();
    return {
      kind: adapter.kind,
      displayName: adapter.displayName,
      capabilities: adapter.capabilities,
      installed: det.installed,
      version: det.version,
    };
  }));
}
