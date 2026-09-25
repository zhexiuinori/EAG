// ---------------------------------------------------------------------------
// EAG Desktop — Electron main process entry
// ---------------------------------------------------------------------------

import { app } from "electron";
import * as path from "node:path";
import { createMainWindow, getMainWindow } from "./window.ts";
import { createTray, destroyTray } from "./tray.ts";
import { registerAllHandlers } from "./ipc-handlers.ts";
import { PROJECT_ROOT } from "./paths.ts";
import * as schedulerService from "./services/scheduler-service.ts";
import * as delegationService from "./services/delegation-service.ts";

// Keep all Electron state inside the project instead of %APPDATA%, so the app
// is self-contained and does not depend on a writable user profile.
app.setPath("userData", path.join(PROJECT_ROOT, ".eag", "userdata"));
app.setPath("sessionData", path.join(PROJECT_ROOT, ".eag", "session"));

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerAllHandlers();
    createMainWindow();
    createTray();
    // 定时任务调度循环（幂等；Web 入口也会启动一次）
    schedulerService.start();
    // 子 Agent 委派循环（幂等；Web 入口也会启动一次）
    delegationService.start();
  });

  app.on("before-quit", () => {
    schedulerService.stop();
    delegationService.stop();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    destroyTray();
  });

  app.on("activate", () => {
    if (!getMainWindow()) createMainWindow();
  });
}
