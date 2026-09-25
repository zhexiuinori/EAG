import { defineConfig } from "vitest/config";

// 测试约定（见 AGENTS.md）：
//   - 测试文件与被测文件同目录，命名 *.test.ts
//   - 断言必须是真实行为断言，禁止"只判断不为 undefined"的假测试
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
