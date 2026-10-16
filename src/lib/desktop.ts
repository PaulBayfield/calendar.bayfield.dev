import { useEffect } from "react";
import { isTauri } from "./auth";
import type { Translate } from "./i18n";

/** Whether the app launches (hidden in the tray) when the user logs in. */
export async function getAutostart(): Promise<boolean> {
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

export async function setAutostart(on: boolean): Promise<void> {
  const { enable, disable } = await import("@tauri-apps/plugin-autostart");
  await (on ? enable() : disable());
}

/** Keeps the native side (tray menu language, close button behaviour) in step with settings. */
export function useDesktopSync(closeToTray: boolean, t: Translate) {
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_close_to_tray", { enabled: closeToTray }));
  }, [closeToTray]);

  const open = t("trayOpen");
  const quit = t("trayQuit");
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_tray_labels", { open, quit }));
  }, [open, quit]);
}
