import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as path from "node:path";

const ROOT = __dirname;

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: ROOT,
  base: "./",
  resolve: {
    alias: {
      "@shared": path.resolve(ROOT, "../shared"),
      "@extension": path.resolve(ROOT, "../../extension"),
      "@swarm": path.resolve(ROOT, "../../swarm"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3789",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
