import { describe, it, expect } from "vitest";
import {
  matchPolicy,
  isAccessAllowed,
  expandPolicyPath,
  resolvePolicyMap,
  mergePolicies,
  normaliseForMatch,
  type PolicyMap,
} from "./policy.ts";

// policy 是 fs-gate 的判定核心：默认 hidden、最长前缀优先、
// Worker 覆盖全局，任何一条失效都直接改变 Agent 的文件可见性。
const policies: PolicyMap = [
  { path: "/data", access: "r" },
  { path: "/data/secret", access: "hidden" },
  { path: "/workspace/project", access: "rw" },
];

describe("matchPolicy — 最长前缀优先", () => {
  it("命中精确路径", () => {
    expect(matchPolicy("/data", policies)?.access).toBe("r");
  });

  it("命中父级前缀", () => {
    expect(matchPolicy("/data/public/file.txt", policies)?.access).toBe("r");
  });

  it("更深条目覆盖父级", () => {
    expect(matchPolicy("/data/secret/keys.txt", policies)?.access).toBe("hidden");
  });

  it("未命中返回 undefined（调用方按 hidden 处理）", () => {
    expect(matchPolicy("/etc/passwd", policies)).toBeUndefined();
  });

  it("前缀必须是完整路径段：/database 不匹配 /data", () => {
    expect(matchPolicy("/database/x", policies)).toBeUndefined();
  });

  it("策略路径尾部斜杠不影响匹配", () => {
    const withSlash: PolicyMap = [{ path: "/data/", access: "r" }];
    expect(matchPolicy("/data/a.txt", withSlash)?.access).toBe("r");
  });
});

describe("isAccessAllowed — 三级访问语义", () => {
  it("rw：读写都允许", () => {
    expect(isAccessAllowed("/workspace/project/a.ts", "read", policies)).toBe(true);
    expect(isAccessAllowed("/workspace/project/a.ts", "write", policies)).toBe(true);
  });

  it("r：只读，写被拒", () => {
    expect(isAccessAllowed("/data/a.txt", "read", policies)).toBe(true);
    expect(isAccessAllowed("/data/a.txt", "write", policies)).toBe(false);
  });

  it("hidden：读写都拒", () => {
    expect(isAccessAllowed("/data/secret/k.txt", "read", policies)).toBe(false);
    expect(isAccessAllowed("/data/secret/k.txt", "write", policies)).toBe(false);
  });

  it("默认 hidden：无策略命中时拒绝一切", () => {
    expect(isAccessAllowed("/root/.ssh/id_rsa", "read", policies)).toBe(false);
    expect(isAccessAllowed("/root/.ssh/id_rsa", "write", policies)).toBe(false);
  });
});

describe("expandPolicyPath — 变量展开", () => {
  it("展开 PROJECT_ROOT 与 WORKSPACE", () => {
    const ctx = { projectRoot: "/repo" };
    expect(expandPolicyPath("${PROJECT_ROOT}/src", ctx)).toBe("/repo/src");
    expect(expandPolicyPath("${WORKSPACE}/docs", ctx)).toBe("/repo/docs");
  });

  it("未识别变量原样保留", () => {
    expect(expandPolicyPath("${NOPE}/x", { projectRoot: "/repo" })).toBe("${NOPE}/x");
  });

  it("resolvePolicyMap 批量展开", () => {
    const out = resolvePolicyMap(
      [{ path: "${PROJECT_ROOT}/a", access: "rw" }],
      { projectRoot: "/repo" },
    );
    expect(out[0].path).toBe("/repo/a");
    expect(out[0].access).toBe("rw");
  });
});

describe("mergePolicies — Worker 覆盖全局", () => {
  it("同路径 Worker 覆盖全局", () => {
    const merged = mergePolicies(
      [{ path: "/data", access: "r" }],
      [{ path: "/data", access: "rw" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].access).toBe("rw");
  });

  it("不同路径两边都保留", () => {
    const merged = mergePolicies(
      [{ path: "/data", access: "r" }],
      [{ path: "/other", access: "rw" }],
    );
    expect(merged).toHaveLength(2);
  });

  it("空覆盖返回原表；空基础返回覆盖表", () => {
    const base: PolicyMap = [{ path: "/data", access: "r" }];
    expect(mergePolicies(base, [])).toBe(base);
    const override: PolicyMap = [{ path: "/w", access: "rw" }];
    expect(mergePolicies([], override)).toBe(override);
  });

  it("覆盖按规范化路径判定（尾部斜杠等价）", () => {
    const merged = mergePolicies(
      [{ path: "/data/", access: "r" }],
      [{ path: "/data", access: "hidden" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].access).toBe("hidden");
  });
});

describe("normaliseForMatch", () => {
  it("统一分隔符并去尾部斜杠", () => {
    expect(normaliseForMatch("/a/b/")).toBe("/a/b");
    expect(normaliseForMatch("\\a\\b\\")).toBe("/a/b");
  });
});
