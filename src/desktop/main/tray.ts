// ---------------------------------------------------------------------------
// EAG Desktop — system tray
// ---------------------------------------------------------------------------

import { Tray, Menu, app, nativeImage } from "electron";
import { getMainWindow } from "./window.ts";

let tray: Tray | null = null;

export function createTray(): Tray {
  const icon = nativeImage.createEmpty();

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show EAG Desktop",
      click: () => {
        const win = getMainWindow();
        if (win) {
          win.show();
          win.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        (app as any).isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("EAG Desktop");
  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });

  return tray;
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
