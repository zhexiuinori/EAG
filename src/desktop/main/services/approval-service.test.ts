import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// approval-service 是审批命脉：文件协议（req-*.json / res-*.json）必须
// 双向闭环，任何一环断了 Agent 侧的挂起写操作就永远等不到裁决。
//
// 服务是模块级单例（records Map），测试间用互不相同的请求 ID 隔离。
let dir: string;
let service: typeof import("./approval-service.ts");

function writeRequest(id: string, ts = new Date().toISOString()): void {
  fs.writeFileSync(
    path.join(dir, `req-${id}.json`),
    JSON.stringify({
      id,
      toolName: "write_file",
      path: "/data/report.md",
      access: "read-only",
      reason: "目标路径为只读策略",
      ts,
      cwd: "/workspace/project",
      pid: 12345,
    }),
    "utf-8",
  );
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eag-approvals-test-"));
  process.env.EAG_APPROVAL_DIR = dir;
  service = await import("./approval-service.ts");
});

afterAll(() => {
  delete process.env.EAG_APPROVAL_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanApprovals — 请求扫描", () => {
  it("发现新的 req 文件并标记 pending", () => {
    writeRequest("t-scan-1");
    service.scanApprovals();

    const rec = service.listApprovals().find((r) => r.id === "t-scan-1");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("pending");
    expect(rec!.toolName).toBe("write_file");
    expect(rec!.path).toBe("/data/report.md");
  });

  it("目录不存在时不报错", () => {
    const saved = process.env.EAG_APPROVAL_DIR;
    process.env.EAG_APPROVAL_DIR = path.join(dir, "does-not-exist");
    expect(() => service.scanApprovals()).not.toThrow();
    process.env.EAG_APPROVAL_DIR = saved;
  });

  it("损坏的请求文件被跳过，不影响其他请求", () => {
    fs.writeFileSync(path.join(dir, "req-t-broken.json"), "{not json", "utf-8");
    writeRequest("t-scan-2");
    service.scanApprovals();

    const rec = service.listApprovals().find((r) => r.id === "t-scan-2");
    expect(rec?.status).toBe("pending");
    expect(service.listApprovals().find((r) => r.id === "t-broken")).toBeUndefined();
  });

  it("非 req- 前缀文件被忽略", () => {
    fs.writeFileSync(path.join(dir, "res-orphan.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(dir, "readme.txt"), "hi", "utf-8");
    expect(() => service.scanApprovals()).not.toThrow();
    expect(service.listApprovals().find((r) => r.id === "orphan")).toBeUndefined();
  });
});

describe("decideApproval — 裁决闭环", () => {
  it("批准后写出 res 文件，状态变 approved", () => {
    writeRequest("t-approve-1");
    service.scanApprovals();

    expect(service.decideApproval("t-approve-1", true)).toBe(true);

    const rec = service.listApprovals().find((r) => r.id === "t-approve-1");
    expect(rec!.status).toBe("approved");
    expect(rec!.decidedAt).toBeDefined();

    const resFile = path.join(dir, "res-t-approve-1.json");
    expect(fs.existsSync(resFile)).toBe(true);
    const res = JSON.parse(fs.readFileSync(resFile, "utf-8"));
    expect(res.id).toBe("t-approve-1");
    expect(res.approved).toBe(true);
  });

  it("拒绝后状态变 denied，res 文件 approved=false", () => {
    writeRequest("t-deny-1");
    service.scanApprovals();

    expect(service.decideApproval("t-deny-1", false)).toBe(true);

    const rec = service.listApprovals().find((r) => r.id === "t-deny-1");
    expect(rec!.status).toBe("denied");

    const res = JSON.parse(fs.readFileSync(path.join(dir, "res-t-deny-1.json"), "utf-8"));
    expect(res.approved).toBe(false);
  });

  it("已裁决的请求不能重复裁决", () => {
    writeRequest("t-twice-1");
    service.scanApprovals();
    expect(service.decideApproval("t-twice-1", true)).toBe(true);
    expect(service.decideApproval("t-twice-1", false)).toBe(false);

    const rec = service.listApprovals().find((r) => r.id === "t-twice-1");
    expect(rec!.status).toBe("approved");
  });

  it("不存在的请求裁决返回 false", () => {
    expect(service.decideApproval("t-nonexistent", true)).toBe(false);
  });
});

describe("审批事件推送", () => {
  it("新请求与裁决都会推送给 sink", () => {
    const events: Array<{ id: string; status: string }> = [];
    service.setApprovalSink((r) => events.push({ id: r.id, status: r.status }));
    try {
      writeRequest("t-sink-1");
      service.scanApprovals();
      service.decideApproval("t-sink-1", true);

      const mine = events.filter((e) => e.id === "t-sink-1");
      expect(mine.map((e) => e.status)).toEqual(["pending", "approved"]);
    } finally {
      service.setApprovalSink(null);
    }
  });
});
