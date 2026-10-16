import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./auth";

/** Opens a link in the system browser (desktop) or a new tab (web). */
export function openExternal(url: string): void {
  if (isTauri) void openUrl(url);
  else window.open(url, "_blank", "noopener");
}
