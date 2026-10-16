import { useCallback, useEffect, useState } from "react";
import { useSettings, type Settings, type Theme } from "../lib/settings";
import { calendarName, isWritable, type Calendar } from "../lib/google";
import { getConnectUrl, getServerStatus, serverBase, type ServerStatus } from "../lib/server";
import { isTauri } from "../lib/auth";
import { openExternal } from "../lib/open";
import type { StringKey } from "../lib/i18n";
import { getAutostart, setAutostart } from "../lib/desktop";
import { notificationPermission, type NotificationPermission } from "../lib/reminders";
import { X } from "./icons";

const THEMES: { id: Theme; label: StringKey }[] = [
  { id: "system", label: "themeSystem" },
  { id: "light", label: "themeLight" },
  { id: "dark", label: "themeDark" },
  { id: "rosepine", label: "themeRosepine" },
  { id: "rosepine-dawn", label: "themeRosepineDawn" },
];

interface Props {
  calendars: Calendar[];
  onClose: () => void;
}

export function SettingsDialog({ calendars, onClose }: Props) {
  const { t, settings, update } = useSettings();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const select = <K extends keyof Settings>(key: K, options: [Settings[K], string][]) => (
    <select
      value={String(settings[key])}
      onChange={(e) => update({ [key]: options.find(([v]) => String(v) === e.target.value)![0] } as Partial<Settings>)}
    >
      {options.map(([value, label]) => (
        <option key={String(value)} value={String(value)}>
          {label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={t("settings")}>
        <div className="dialog-header">
          <h2>{t("settings")}</h2>
          <button className="icon-button small" aria-label={t("close")} onClick={onClose}>
            <X />
          </button>
        </div>

        <section>
          <h3>{t("appearance")}</h3>
          <div className="theme-picker">
            {THEMES.map(({ id, label }) => (
              <button
                key={id}
                className={`theme-card${settings.theme === id ? " active" : ""}`}
                onClick={() => update({ theme: id })}
              >
                <span className={`theme-preview ${id}`}>
                  <span />
                  <span />
                  <span />
                </span>
                {t(label)}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-grid">
          <label>
            <span>{t("language")}</span>
            {select("language", [
              ["auto", t("automatic")],
              ["fr", "Français"],
              ["en", "English"],
            ])}
          </label>
          <label>
            <span>{t("weekStart")}</span>
            {select("weekStartsOn", [
              [1, t("monday")],
              [0, t("sunday")],
            ])}
          </label>
          <label>
            <span>{t("timeFormat")}</span>
            {select("timeFormat", [
              ["auto", t("automatic")],
              ["24h", "24h"],
              ["12h", "12h"],
            ])}
          </label>
          <label>
            <span>{t("eventDetails")}</span>
            {select("eventDetails", [
              ["popover", t("popup")],
              ["panel", t("sidePanel")],
            ])}
          </label>
          <label>
            <span>{t("defaultDuration")}</span>
            {select(
              "defaultDuration",
              [15, 30, 45, 60, 90].map((n) => [n, t("minutes", { n })]),
            )}
          </label>
          <label>
            <span>{t("defaultCalendar")}</span>
            <select
              value={settings.defaultCalendarId ?? ""}
              onChange={(e) => update({ defaultCalendarId: e.target.value || undefined })}
            >
              <option value="">—</option>
              {calendars.filter(isWritable).map((c) => (
                <option key={c.id} value={c.id}>
                  {calendarName(c)}
                </option>
              ))}
            </select>
          </label>
        </section>

        <NotificationsSection />
        <ServerSection />
      </div>
    </div>
  );
}

function NotificationsSection() {
  const { t, settings, update } = useSettings();
  const [permission, setPermission] = useState<NotificationPermission>("granted");
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  useEffect(() => {
    notificationPermission().then(setPermission, () => setPermission("denied"));
    if (isTauri) getAutostart().then(setAutostartState, () => {});
  }, []);

  const toggleNotifications = async (on: boolean) => {
    // Browsers only show the permission prompt in response to a click like this one.
    if (on) setPermission(await notificationPermission(true).catch(() => "denied" as const));
    update({ notifications: on });
  };
  const toggleAutostart = async (on: boolean) => {
    setAutostartState(on);
    await setAutostart(on).catch(() => setAutostartState(!on));
  };

  return (
    <section className="settings-checks">
      <h3>{isTauri ? t("desktop") : t("notifications")}</h3>
      <label className="checkbox-row">
        <input type="checkbox" checked={settings.notifications} onChange={(e) => toggleNotifications(e.target.checked)} />
        {t("notifyBefore")}
      </label>
      {settings.notifications && permission === "denied" && <p className="small muted">{t("notificationsBlocked")}</p>}
      {settings.notifications && permission === "default" && (
        <button className="text-button" onClick={() => toggleNotifications(true)}>
          {t("allowNotifications")}
        </button>
      )}
      {isTauri && (
        <>
          <label className="checkbox-row">
            <input type="checkbox" checked={settings.closeToTray} onChange={(e) => update({ closeToTray: e.target.checked })} />
            {t("closeToTray")}
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!autostart}
              disabled={autostart === null}
              onChange={(e) => toggleAutostart(e.target.checked)}
            />
            {t("launchAtStartup")}
          </label>
        </>
      )}
    </section>
  );
}

function ServerSection() {
  const { t, settings, update } = useSettings();
  const [url, setUrl] = useState(settings.serverUrl);
  const [status, setStatus] = useState<ServerStatus | "checking" | { error: string } | null>(null);
  const base = serverBase(settings.serverUrl);

  const check = useCallback(() => {
    if (!base) return setStatus(null);
    setStatus("checking");
    getServerStatus(base).then(setStatus, (e: Error) => setStatus({ error: e.message }));
  }, [base]);
  useEffect(check, [check]);

  // Re-check when coming back from the Google consent tab.
  useEffect(() => {
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [check]);

  const connect = async () => {
    try {
      openExternal((await getConnectUrl(base)).url);
    } catch (e) {
      setStatus({ error: (e as Error).message });
    }
  };

  return (
    <section>
      <h3>{t("server")}</h3>
      <div className="server-row">
        <input
          type="url"
          placeholder={isTauri ? "https://calendar.bayfield.dev" : location.origin}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => url !== settings.serverUrl && update({ serverUrl: url.trim() })}
        />
      </div>
      <div className="server-row">
        <span className="small muted">
          {status === "checking"
            ? t("checking")
            : status && "error" in status
              ? status.error
              : status?.connected
                ? t("connectedAs", { email: status.email ?? "" })
                : base
                  ? t("notConnected")
                  : t("serverNotConfigured")}
        </span>
        {base && status !== "checking" && !(status && "connected" in status && status.connected) && (
          <button className="text-button" onClick={connect}>
            {t("connectGoogle")}
          </button>
        )}
      </div>
    </section>
  );
}
