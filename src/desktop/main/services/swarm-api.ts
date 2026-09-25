// ---------------------------------------------------------------------------
// EAG Desktop — Swarm API service
// ---------------------------------------------------------------------------

import type { UserRequest, SwarmResult, WorkerPoolConfig, SwarmProgressEvent } from "../../../swarm/types.ts";
import { executeSwarm } from "../../../swarm/orchestrator.ts";

export async function swarmExecute(
  request: UserRequest,
  config?: Partial<WorkerPoolConfig>,
  onProgress?: (e: SwarmProgressEvent) => void,
): Promise<SwarmResult> {
  return executeSwarm(request, config, onProgress);
}
