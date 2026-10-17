import { useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/auth";
import { useSettings } from "../lib/settings";
import { ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, PanelLeft, PanelRight, WinMaximize, WinMinimize, X } from "./icons";

interface Props {
  title: string;
  loading: boolean;
  account?: string;
  panelVisible: boolean;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onTogglePanel: () => void;
  showSidebarToggle: boolean;
  onToggleSidebar: () => void;
  days: number;
  maxDays: number;
  onDays: (n: number) => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}

export const MAX_DAYS = 14;

export function Toolbar(p: Props) {
  const { t } = useSettings();

  return (
    <header className="toolbar" data-tauri-drag-region>
      {p.showSidebarToggle && (
        <button className="icon-button" title={`${t("toggleSidebar")} (Ctrl+B)`} onClick={p.onToggleSidebar}>
          <PanelLeft />
        </button>
      )}
      <h1 className="toolbar-title" data-tauri-drag-region>
        {p.title}
      </h1>
      {p.loading && <span className="spinner" aria-label="Loading" />}
      <div className="toolbar-spacer" data-tauri-drag-region />
      <AccountMenu account={p.account} onOpenSettings={p.onOpenSettings} onSignOut={p.onSignOut} />
      <DaysMenu days={p.days} max={p.maxDays} onDays={p.onDays} />
      <button className="text-button" onClick={p.onToday} title={`${t("today")} (T)`}>
        {t("today")}
      </button>
      <div className="button-group">
        <button className="icon-button" aria-label={t("previous")} title={`${t("previous")} (K)`} onClick={p.onPrev}>
          <ChevronLeft />
        </button>
        <button className="icon-button" aria-label={t("next")} title={`${t("next")} (J)`} onClick={p.onNext}>
          <ChevronRight />
        </button>
      </div>
      <PrivacyToggle />
      <button
        className={`icon-button panel-toggle${p.panelVisible ? " active" : ""}`}
        title={`${t("togglePanel")} (.)`}
        aria-pressed={p.panelVisible}
        onClick={p.onTogglePanel}
      >
        <PanelRight />
      </button>
      {isTauri && !p.panelVisible && <WindowControls />}
    </header>
  );
}

function PrivacyToggle() {
  const { t, settings, update } = useSettings();
  return (
    <button
      className={`icon-button${settings.privacy ? " active" : ""}`}
      title={`${t(settings.privacy ? "privacyOff" : "privacyOn")} (H)`}
      aria-pressed={settings.privacy}
      onClick={() => update({ privacy: !settings.privacy })}
    >
      {settings.privacy ? <EyeOff /> : <Eye />}
    </button>
  );
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);
  return ref;
}

function DaysMenu({ days, max, onDays }: { days: number; max: number; onDays: (n: number) => void }) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const label = (n: number) => (n === 1 ? t("oneDay") : t("days", { n }));

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="text-button" onClick={() => setOpen(!open)}>
        {label(days)} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              role="menuitemradio"
              aria-checked={days === n}
              className={days === n ? "active" : ""}
              onClick={() => {
                onDays(n);
                setOpen(false);
              }}
            >
              <span>{n === 7 ? `${label(7)} · ${t("week")}` : label(n)}</span>
              <kbd>{n === 7 ? "W" : n === 1 ? "D" : n <= 9 ? n : n === 10 ? "0" : ""}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountMenu(p: { account?: string; onOpenSettings: () => void; onSignOut: () => void }) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const initial = (p.account ?? "?").charAt(0).toUpperCase();

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="avatar" title={p.account} onClick={() => setOpen(!open)}>
        {initial}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-label">{p.account}</div>
          <button
            onClick={() => {
              setOpen(false);
              p.onOpenSettings();
            }}
          >
            {t("settings")} <kbd>Ctrl</kbd> <kbd>,</kbd>
          </button>
          <button onClick={p.onSignOut}>{t("signOut")}</button>
        </div>
      )}
    </div>
  );
}

export function WindowControls() {
  const { t } = useSettings();
  const run = (action: "minimize" | "toggleMaximize" | "close") => async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[action]();
  };
  return (
    <div className="window-controls">
      <button aria-label={t("minimize")} onClick={run("minimize")}>
        <WinMinimize size={14} />
      </button>
      <button aria-label={t("maximize")} onClick={run("toggleMaximize")}>
        <WinMaximize size={12} />
      </button>
      <button className="close" aria-label={t("close")} onClick={run("close")}>
        <X size={14} />
      </button>
    </div>
  );
}
