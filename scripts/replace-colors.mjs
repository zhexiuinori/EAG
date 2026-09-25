// Bulk replace old color tokens with new n-* tokens across all components/pages.
// Run with: node scripts/replace-colors.mjs

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = join(import.meta.dirname, "..", "src", "desktop", "renderer", "src");
const EXTENSIONS = [".tsx", ".ts", ".css", ".html"];

const REPLACE = [
  // surface-* → n-*
  [/bg-surface-/g, "bg-n-"],
  [/text-surface-/g, "text-n-"],
  [/border-surface-/g, "border-n-"],
  [/from-surface-/g, "from-n-"],
  [/to-surface-/g, "to-n-"],
  [/shadow-surface-/g, "shadow-n-"],
  [/ring-surface-/g, "ring-n-"],
  [/divide-surface-/g, "divide-n-"],
  [/placeholder-surface-/g, "placeholder-n-"],
  [/outline-surface-/g, "outline-n-"],
  [/var\(--color-surface-/g, "var(--color-n-"],

  // eag-* → n-* (neutral, no brand color)
  [/bg-eag-/g, "bg-n-"],
  [/text-eag-/g, "text-n-"],
  [/border-eag-/g, "border-n-"],
  [/from-eag-/g, "from-n-"],
  [/via-eag-/g, "via-n-"],
  [/to-eag-/g, "to-n-"],
  [/shadow-eag-/g, "shadow-n-"],
  [/ring-eag-/g, "ring-n-"],

  // accent-* → red/green/yellow/blue
  [/accent-green/g, "green"],
  [/accent-red/g, "red"],
  [/accent-yellow/g, "yellow"],
  [/accent-blue/g, "blue"],
  [/accent-cyan/g, "blue"],

  // surface-50 etc (standalone)
  [/-surface-50/g, "-n-50"],
  [/-surface-100/g, "-n-100"],
  [/-surface-200/g, "-n-200"],
  [/-surface-300/g, "-n-300"],
  [/-surface-400/g, "-n-400"],
  [/-surface-500/g, "-n-500"],
  [/-surface-600/g, "-n-600"],
  [/-surface-700/g, "-n-700"],
  [/-surface-800/g, "-n-800"],
  [/-surface-850/g, "-n-850"],
  [/-surface-900/g, "-n-900"],
  [/-surface-950/g, "-n-950"],
  [/-surface-1000/g, "-n-1000"],
];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, entry.name);
    if (entry.isDirectory()) walk(fp);
    else if (EXTENSIONS.includes(extname(fp))) {
      let content = readFileSync(fp, "utf-8");
      const before = content;
      for (const [re, to] of REPLACE) {
        content = content.replace(re, to);
      }
      if (content !== before) {
        writeFileSync(fp, content);
        console.log("  patched", fp.replace(ROOT, ""));
      }
    }
  }
}

console.log("Replacing color tokens...");
walk(ROOT);
console.log("Done.");
