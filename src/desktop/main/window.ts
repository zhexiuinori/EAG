// ---------------------------------------------------------------------------
// EAG Desktop — window management
// ---------------------------------------------------------------------------

import { BrowserWindow } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// After the esbuild step this file lives at <root>/dist-electron/main.mjs,
// so __dirname resolves to <root>/dist-electron.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(HERE, "preload.cjs");
const RENDERER_INDEX = path.resolve(HERE, "../src/desktop/renderer/dist/index.html");

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "EAG Desktop",
    backgroundColor: "#070b17",
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Set EAG_DEV_SERVER=http://localhost:5173 to load the Vite dev server.
  const devServer = process.env.EAG_DEV_SERVER;
  if (devServer) {
    mainWindow.loadURL(devServer);
  } else {
    mainWindow.loadFile(RENDERER_INDEX);
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}
