import express from "express";
import cors from "cors";
import * as workerService from "../desktop/main/services/worker-service.ts";
import * as userService from "../desktop/main/services/user-service.ts";
import * as groupService from "../desktop/main/services/group-service.ts";
import * as policyApi from "../desktop/main/services/policy-api.ts";
import * as configApi from "../desktop/main/services/config-api.ts";
import * as mcpService from "../desktop/main/services/mcp-service.ts";
import * as knowledgeService from "../desktop/main/services/knowledge-service.ts";
import * as schedulerService from "../desktop/main/services/scheduler-service.ts";
import * as delegationService from "../desktop/main/services/delegation-service.ts";
import * as providerHealthService from "../desktop/main/services/provider-health.ts";
import * as notificationService from "../desktop/main/services/notification-service.ts";
import { listAdapterStatus } from "../desktop/main/adapters/registry.ts";
import type { AuthSession } from "../desktop/shared/types.ts";

const app = express();

// 仅允许本机来源（Electron 渲染进程 / 本地 dev server）。
// 原先 cors() 全开，任何网页都能读取 workers / users / policy / audit。
app.use(cors({
  origin: (origin, callback) => {
    // 无 Origin：同源请求、curl、Electron file:// 加载
    if (!origin) return callback(null, true);
    const allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    callback(allowed ? null : new Error(`CORS: 不允许的来源 ${origin}`), allowed);
  },
}));
app.use(express.json());

const PORT = Number(process.env.EAG_API_PORT) || 3789;

// In-memory chat history: keyed by session ID (userId:workerId)
const chatHistory: Record<string, { role: "user" | "assistant"; content: string }[]> = {};

// 历史条数上限，避免长会话无限占用内存
const MAX_HISTORY_PER_SESSION = 200;
function pushHistory(key: string, entry: { role: "user" | "assistant"; content: string }): void {
  const list = chatHistory[key] ?? [];
  list.push(entry);
  chatHistory[key] = list.length > MAX_HISTORY_PER_SESSION
    ? list.slice(-MAX_HISTORY_PER_SESSION)
    : list;
}

function getChatKey(userId: string, workerId: string): string {
  return `${userId}:${workerId}`;
}

/**
 * 请求级身份解析（与 IPC 侧一致）：
 *   1. 登录签发的 token（x-eag-token 头）—— Web 模式身份凭证，可验证、可失效
 *   2. x-eag-user 旧式头（兼容过渡期）
 *   3. 进程内全局 session（Electron IPC / 无状态调用方）
 */
function sessionUser(req: express.Request): AuthSession {
  return userService.resolveIdentity(
    req.header("x-eag-token"),
    req.header("x-eag-user"),
  );
}

/** 管理接口守卫：admin 或获授后台权限者放行，否则 403。 */
function requireConsole(session: AuthSession): void {
  if (session.role !== "admin" && !session.canManageConsole) {
    const err: any = new Error("无权访问管理控制台");
    err.status = 403;
    throw err;
  }
}

/** 管理接口守卫中间件（工厂），用于整组路由。 */
function guardConsole() {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    try {
      requireConsole(sessionUser(req));
      next();
    } catch (e) {
      next(e);
    }
  };
}

// -- 管理接口（守护：仅挂在 /api/admin 下，不拦住聊天/登录/工作区等用户侧接口） --
const consoleApi = express.Router();

// 管理数据：全量列表含他人配置，需后台权限（admin 或被单独授权者）
consoleApi.get("/workers", (_req, res) => res.json({ workers: workerService.listWorkers() }));
consoleApi.post("/workers", (req, res) => res.json(workerService.createWorker(req.body)));
consoleApi.put("/workers/:id", (req, res) => res.json(workerService.updateWorker({ id: req.params.id, patch: req.body })));
consoleApi.delete("/workers/:id", (_req, res) => { workerService.deleteWorker(_req.params.id); res.json({ ok: true }); });
consoleApi.post("/workers/:id/start", async (req, res) => res.json({ started: await workerService.startWorker(req.params.id) }));
// 重新分配（多用户 + 组）—— 与 Electron 模式共用同一份 worker-service 逻辑
consoleApi.post("/workers/:id/assign", (req, res) => {
  const w = workerService.assignWorker({
    id: req.params.id,
    userIds: req.body?.userIds ?? [],
    groupIds: req.body?.groupIds ?? [],
  });
  if (!w) return res.status(404).json({ error: "Worker not found" });
  res.json(w);
});

// 用户 / 组 / 策略 / 配置（管理数据，需后台权限）
consoleApi.get("/users", (_req, res) => res.json({ users: userService.listUsers() }));
consoleApi.post("/users", (req, res) => {
  try {
    return res.json(userService.createUser(req.body));
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
});
consoleApi.put("/users/:id", (req, res) => {
  try {
    const u = userService.updateUser({ id: req.params.id, ...req.body });
    if (!u) return res.status(404).json({ error: "用户不存在" });
    res.json(u);
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
});
consoleApi.delete("/users/:id", (req, res) => { userService.deleteUser(req.params.id); res.json({ ok: true }); });

consoleApi.get("/groups", (_req, res) => res.json({ groups: groupService.listGroups() }));
consoleApi.post("/groups", (req, res) => res.json(groupService.upsertGroup(req.body)));
consoleApi.delete("/groups/:id", (req, res) => {
  const ok = groupService.deleteGroup(req.params.id);
  if (ok) workerService.removeGroupFromAssignments(req.params.id);
  res.json(ok);
});

// 通知：无人值守结果（站内铃铛 + Webhook 外推；测试会等待外推结果以便如实反馈）
consoleApi.get("/notifications", (_req, res) => res.json(notificationService.list()));
consoleApi.post("/notifications/read", (req, res) => res.json(notificationService.markRead(req.body?.ids)));
consoleApi.post("/notifications/clear", (_req, res) => res.json({ ok: notificationService.clear() }));
consoleApi.post("/notifications/test", async (_req, res) => res.json(await notificationService.test()));

// 子 Agent 委派记录（可视化：治理总览的时间线）
consoleApi.get("/delegations", (_req, res) => res.json({ delegations: delegationService.list() }));

// 配置体检：Provider 连通性 + Agent 可运行性（非计费探测，约 4s 内返回）
consoleApi.get("/providers/health", async (_req, res) => res.json(await providerHealthService.healthCheck()));

// 定时任务：周期触发 Agent（执行走同一治理通道：预算/策略/审计）
consoleApi.get("/schedules", (_req, res) => res.json({ jobs: schedulerService.listJobs() }));
consoleApi.post("/schedules", (req, res) => {
  try {
    return res.json(schedulerService.upsertJob(req.body));
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
});
consoleApi.delete("/schedules/:id", (req, res) => res.json({ ok: schedulerService.deleteJob(req.params.id) }));
consoleApi.post("/schedules/:id/run", async (req, res) => {
  const r = await schedulerService.runJob(req.params.id, "manual");
  res.json(r);
});

// Knowledge（RAG）：向量化走配置的 Embedding Provider，检索写审计
consoleApi.get("/knowledge", (_req, res) => res.json({ collections: knowledgeService.listCollections() }));
consoleApi.post("/knowledge", (req, res) => res.json(knowledgeService.upsertCollection(req.body)));
consoleApi.get("/knowledge/:id", (req, res) => {
  const d = knowledgeService.getDetail(req.params.id);
  if (!d) return res.status(404).json({ error: "知识库不存在" });
  res.json(d);
});
consoleApi.delete("/knowledge/:id", (req, res) => res.json({ ok: knowledgeService.deleteCollection(req.params.id) }));
consoleApi.delete("/knowledge/:id/docs/:docId", (req, res) =>
  res.json({ ok: knowledgeService.deleteDoc(req.params.id, req.params.docId) }));
consoleApi.post("/knowledge/:id/ingest", async (req, res) => {
  const s = sessionUser(req);
  const r = await knowledgeService.ingest(
    { collectionId: req.params.id, title: req.body?.title, text: req.body?.text, path: req.body?.path },
    s.userId || "console",
  );
  res.json(r);
});
consoleApi.post("/knowledge/search", async (req, res) => {
  const s = sessionUser(req);
  const r = await knowledgeService.search(
    { collectionId: req.body?.collectionId, query: req.body?.query, topK: req.body?.topK },
    s.userId || "console",
  );
  res.json(r);
});

// MCP：外部工具纳管（列出/配置/工具清单/调用），调用在 mcp-service 内过策略与审计
consoleApi.get("/mcp", (_req, res) => res.json({ servers: mcpService.listServers() }));
consoleApi.post("/mcp", (req, res) => {
  try {
    return res.json(mcpService.upsertServer(req.body));
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
});
consoleApi.delete("/mcp/:id", (req, res) => res.json({ ok: mcpService.deleteServer(req.params.id) }));
consoleApi.post("/mcp/:id/stop", (req, res) => {
  mcpService.stopServer(req.params.id);
  res.json({ ok: true });
});
consoleApi.get("/mcp/:id/tools", async (req, res) => res.json(await mcpService.listTools(req.params.id)));
consoleApi.post("/mcp/:id/call", async (req, res) => {
  const s = sessionUser(req);
  try {
    const r = await mcpService.callTool(
      { id: req.params.id, tool: req.body?.tool, args: req.body?.args, workerId: req.body?.workerId },
      s.userId || "console",
    );
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: (e as Error)?.message ?? String(e) });
  }
});

consoleApi.get("/policy", (_req, res) => res.json({ policies: policyApi.getPolicy() }));
consoleApi.put("/policy", (req, res) => { policyApi.updatePolicy(req.body.policies); res.json({ ok: true }); });

consoleApi.get("/config", (_req, res) => res.json(configApi.getConfig()));
consoleApi.put("/config", (req, res) => { configApi.updateConfig(req.body); res.json({ ok: true }); });

consoleApi.get("/status", (req, res) => {
  res.json({ piRunning: false, userId: sessionUser(req).userId, policyEntryCount: policyApi.getPolicy().length, auditTodayCount: 0, uptime: Math.floor(process.uptime()) });
});

app.use("/api/admin", guardConsole(), consoleApi);

// 统一 JSON 错误（含守卫 403）：Express 默认返回 HTML 500，前端没法解析
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err?.status || 500;
  res.status(status).json({ error: err?.message ?? "服务器错误" });
});

// -- Agent adapters --
app.get("/api/adapters", async (_req, res) => res.json({ adapters: await listAdapterStatus() }));

// -- Chat --
/**
 * 发送一条消息。两种响应形态：
 *
 *   · `Accept: application/x-ndjson`（Web UI 用）—— **事件流式**返回：
 *       每行一个 {type:"event", event:AgentEvent}
 *       最后一行 {type:"done", reply, error}
 *     这样 Web 模式与 Electron 一致：文本增量实时出现、工具调用即时成卡片，
 *     而不是"盯着转圈等一整轮跑完再一次蹦出来"。
 *
 *   · 默认 —— 一次性 JSON（向后兼容：脚本 / curl / 旧客户端）。
 *
 * 事件形态与 Electron 侧完全同构（同一个 onEvent 回调），前端可以复用同一套处理逻辑。
 */
app.post("/api/chat/:workerId", async (req, res) => {
  const { workerId } = req.params;
  const { message, modelProviderId, modelName } = req.body;
  const session = sessionUser(req);
  const worker = workerService.getWorker(workerId);

  if (!worker) return res.status(404).json({ error: "Worker not found" });
  if (!message || typeof message !== "string") return res.status(400).json({ error: "message required" });

  const key = getChatKey(session.userId, workerId);
  if (!chatHistory[key]) chatHistory[key] = [];

  // Record user message
  pushHistory(key, { role: "user", content: message });

  // Model override from chat request (TopBar selection), else active config model.
  const modelOverride = { modelProviderId, modelName };
  const resolved = workerService.resolveModelRef(worker, modelOverride);
  const effectiveModel = `${resolved.providerName} · ${resolved.modelName}`;

  const wantsStream = String(req.header("accept") ?? "").includes("application/x-ndjson");
  if (wantsStream) {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    // 反代（nginx 等）默认会缓冲：显式关闭，否则流式退化成一次性
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
  }
  const onEvent = wantsStream
    ? (ev: unknown) => {
        if (res.writableEnded) return;
        res.write(JSON.stringify({ type: "event", event: ev }) + "\n");
      }
    : undefined;

  // Try to get a real response from the Pi worker subprocess
  let reply = "";
  let error: string | undefined;

  try {
    const result = await workerService.sendToWorker(
      workerId, message, modelOverride, onEvent as any, session.userId,
      req.body?.attachments, req.body?.planOnly === true,
    );
    reply = result.output;
    if (!result.success) error = result.error;
  } catch (e: any) {
    error = e?.message ?? String(e);
  }

  // If no reply from Pi, return a fallback
  if (!reply) {
    reply = `[Worker: ${worker.name}]\nModel: ${effectiveModel}\nStatus: ${error ? `Error: ${error}` : "No response from agent"}\n\nYou said: "${message}"`;
  }

  pushHistory(key, { role: "assistant", content: reply });

  if (wantsStream) {
    res.write(JSON.stringify({ type: "done", reply, error }) + "\n");
    return res.end();
  }

  res.json({
    reply,
    history: chatHistory[key],
    error,
  });
});

/** 停止生成：终止这一轮的 Agent 子进程（Web 侧原本是空实现，按钮点了没用）。 */
app.post("/api/chat/:workerId/abort", async (req, res) => {
  const session = sessionUser(req);
  if (!session.userId) return res.status(401).json({ error: "未登录" });
  res.json({ aborted: await workerService.abortChat(req.params.workerId) });
});

// Get chat history
app.get("/api/chat/:workerId", (req, res) => {
  const session = sessionUser(req);
  const key = getChatKey(session.userId, req.params.workerId);
  res.json({ history: chatHistory[key] || [] });
});

// -- Auth --
app.get("/api/auth/session", (req, res) => res.json(sessionUser(req)));
app.post("/api/auth/login", (req, res) => {
  const r = userService.login({ username: req.body?.username, password: req.body?.password });
  if (!r) return res.status(401).json({ error: "用户名或密码错误" });
  res.json(r);
});
app.post("/api/auth/logout", (req, res) => {
  userService.logout(req.header("x-eag-token"));
  res.json({ ok: true });
});
app.post("/api/auth/change-password", (req, res) => {
  const s = sessionUser(req);
  if (!s.userId) {
    console.log("[auth] change-password 401 未登录");
    return res.status(401).json({ error: "未登录" });
  }
  const hasOld = !!req.body?.oldPassword;
  const newLen = String(req.body?.newPassword ?? "").length;
  const r = userService.changePassword(s.userId, req.body?.oldPassword, req.body?.newPassword);
  // 诊断日志：每次改密请求都留痕（含是否带旧密码、新密码长度、结果）
  console.log(`[auth] change-password user=${s.userName} hasOld=${hasOld} newLen=${newLen} -> ${r ? "ok" : "fail"}`);
  if (!r) return res.status(400).json({ error: "旧密码不正确，或新密码不足 6 位" });
  res.json(r);
});

// -- Workspace --
app.get("/api/workspace", (req, res) => {
  const session = sessionUser(req);
  res.json({ workers: workerService.listWorkersForUser(session.userId) });
});

// -- Provider Test --
app.post("/api/providers/test", async (req, res) => {
  const result = await configApi.testProvider(req.body);
  res.json(result);
});

// Legacy status
app.get("/api/status", (req, res) => {
  res.json({ piRunning: false, userId: sessionUser(req).userId, policyEntryCount: policyApi.getPolicy().length, auditTodayCount: 0, uptime: Math.floor(process.uptime()) });
});

app.listen(PORT, () => {
  console.log(`[EAG API] http://localhost:${PORT}`);
  // 调度循环：30s 检查一次到期任务（幂等，Electron 入口也会启动一次）
  schedulerService.start();
  // 子 Agent 委派循环：1.2s 扫描一次文件队列（幂等，Electron 入口也会启动一次）
  delegationService.start();
});
