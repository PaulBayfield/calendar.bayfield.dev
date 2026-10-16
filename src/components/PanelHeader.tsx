import type { ReactNode } from "react";
import { isTauri } from "../lib/auth";
import { useSettings } from "../lib/settings";
import { WindowControls } from "./Toolbar";
import { X } from "./icons";

/** Header row of the side panel, aligned with the main toolbar. Hosts the window controls on desktop. */
export function PanelHeader({ label, onClose, children }: { label: string; onClose?: () => void; children?: ReactNode }) {
  const { t } = useSettings();
  return (
    <div className="panel-header" data-tauri-drag-region>
      <span className="panel-label" data-tauri-drag-region>
        {label}
      </span>
      <div className="toolbar-spacer" data-tauri-drag-region />
      {children}
      {/* On desktop the window's own close button sits right here, so rely on the toolbar toggle / Esc instead. */}
      {onClose && !isTauri && (
        <button className="icon-button" aria-label={t("close")} title={`${t("close")} (Esc)`} onClick={onClose}>
          <X />
        </button>
      )}
      {isTauri && <WindowControls />}
    </div>
  );
}
