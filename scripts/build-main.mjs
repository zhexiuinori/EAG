// Compile the Electron main process (ESM) and preload script (CJS) with esbuild.
// Also emits JS for the governance extension and the worker launcher —
// the production bundle has no `tsx` loader, so `node <file>.ts` would fail.
// The renderer is built separately by Vite.

import { build } from "esbuild";
import { rm, cp } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outdir = path.join(root, "dist-electron");

await rm(outdir, { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  // Electron and the Pi SDK are resolved from node_modules at runtime.
  external: ["electron", "@earendil-works/*"],
};

// Main process stays ESM so `import.meta.url` keeps working in the services.
await build({
  ...shared,
  format: "esm",
  entryPoints: [path.join(root, "src/desktop/main/index.ts")],
  outfile: path.join(outdir, "main.mjs"),
});

// Preload must be CJS (it only uses contextBridge/ipcRenderer).
await build({
  ...shared,
  format: "cjs",
  entryPoints: [path.join(root, "src/desktop/preload/index.ts")],
  outfile: path.join(outdir, "preload.cjs"),
});

// Governance extension + worker launcher.
// Previously these were spawned as raw .ts files, which only works when the
// `tsx` loader is present (a devDependency) — i.e. never in a packaged app.
await build({
  ...shared,
  format: "esm",
  entryPoints: [
    path.join(root, "src/extension/index.ts"),
    path.join(root, "src/launcher/eag-launch.ts"),
    // MCP 治理代理：被 Agent 引擎直接 spawn，必须是可执行 JS
    path.join(root, "src/desktop/main/mcp-proxy.ts"),
  ],
  outdir: path.join(outdir, "runtime"),
  outbase: path.join(root, "src"),
});

// Claude Code 的 PreToolUse hook（命令拦截），仅在 EAG_CLAUDE_HOOKS=1 时挂载
await build({
  ...shared,
  format: "esm",
  entryPoints: [path.join(root, "src/desktop/main/hooks/pre-tool-use.ts")],
  outfile: path.join(outdir, "runtime", "hooks", "pre-tool-use.mjs"),
});

// The extension loads policy.json from its own directory at runtime.
await cp(
  path.join(root, "src/extension/policy.json"),
  path.join(outdir, "runtime", "extension", "policy.json"),
);

console.log("[build-main] done ->", outdir);
