import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSettings, type Settings, type Theme } from "../lib/settings";
import { calendarName, isWritable, type Calendar } from "../lib/google";
import { getConnectUrl, getServerStatus, serverBase, type ServerStatus } from "../lib/server";
import { isTauri } from "../lib/auth";
import { openExternal } from "../lib/open";
import type { StringKey } from "../lib/i18n";
import { getAutostart, setAutostart } from "../lib/desktop";
import { notificationPermission, type NotificationPermission } from "../lib/reminders";
import { APP_VERSION, RELEASES_URL, useUpdateCheck } from "../lib/updates";
import { ShortcutList } from "./Shortcuts";
import { Bell, Globe, Info, Keyboard, Sliders, X } from "./icons";

const THEMES: { id: Theme; label: StringKey }[] = [
  { id: "system", label: "themeSystem" },
  { id: "light", label: "themeLight" },
  { id: "dark", label: "themeDark" },
  { id: "rosepine", label: "themeRosepine" },
  { id: "rosepine-dawn", label: "themeRosepineDawn" },
];

export type SettingsPage = "preferences" | "notifications" | "server" | "shortcuts" | "about";

interface Props {
  calendars: Calendar[];
  page?: SettingsPage;
  onClose: () => void;
}

export function SettingsDialog({ calendars, page: initialPage, onClose }: Props) {
  const { t } = useSettings();
  const [page, setPage] = useState<SettingsPage>(initialPage ?? "preferences");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items: { id: SettingsPage; label: StringKey; icon: ReactNode; page: () => ReactNode }[] = [
    { id: "preferences", label: "preferences", icon: <Sliders />, page: () => <PreferencesPage calendars={calendars} /> },
    { id: "notifications", label: isTauri ? "notificationsDesktop" : "notifications", icon: <Bell />, page: () => <NotificationsPage /> },
    { id: "server", label: "serverShort", icon: <Globe />, page: () => <ServerPage /> },
    { id: "shortcuts", label: "shortcuts", icon: <Keyboard />, page: () => <ShortcutsPage /> },
    { id: "about", label: "about", icon: <Info />, page: () => <AboutPage /> },
  ];
  const current = items.find((i) => i.id === page) ?? items[0];

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-modal" role="dialog" aria-label={t("settings")}>
        <nav className="settings-nav">
          <div className="settings-nav-label">{t("settings")}</div>
          {items.map((i) => (
            <button key={i.id} className={`settings-nav-item${current.id === i.id ? " active" : ""}`} onClick={() => setPage(i.id)}>
              {i.icon}
              <span>{t(i.label)}</span>
            </button>
          ))}
          <button className="settings-version" onClick={() => setPage("about")}>
            {t("versionLabel", { version: APP_VERSION })}
          </button>
        </nav>
        <div className="settings-content">
          <button className="icon-button small settings-close" aria-label={t("close")} onClick={onClose}>
            <X />
          </button>
          <div className="settings-page" key={current.id}>
            {current.page()}
          </div>
        </div>
      </div>
    </div>
  );
}

function PageHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <header className="settings-page-header">
      <h2>{title}</h2>
      {hint && <p className="small muted">{hint}</p>}
    </header>
  );
}

/** A setting: its name and explanation on the left, the control on the right. */
function Row({ label, hint, children, disabled }: { label: ReactNode; hint?: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`setting-row${disabled ? " disabled" : ""}`}>
      <div className="setting-text">
        <span>{label}</span>
        {hint && <span className="settings-hint">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
}

function PreferencesPage({ calendars }: { calendars: Calendar[] }) {
  const { t, settings, update } = useSettings();

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
    <>
      <PageHeader title={t("preferences")} hint={t("preferencesHint")} />
      <section>
        <h3>{t("appearance")}</h3>
        <div className="theme-picker">
          {THEMES.map(({ id, label }) => (
            <button key={id} className={`theme-card${settings.theme === id ? " active" : ""}`} onClick={() => update({ theme: id })}>
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
      <section className="settings-rows">
        <Row label={t("language")}>
          {select("language", [
            ["auto", t("automatic")],
            ["fr", "Français"],
            ["en", "English"],
          ])}
        </Row>
        <Row label={t("weekStart")}>
          {select("weekStartsOn", [
            [1, t("monday")],
            [0, t("sunday")],
          ])}
        </Row>
        <Row label={t("timeFormat")}>
          {select("timeFormat", [
            ["auto", t("automatic")],
            ["24h", "24h"],
            ["12h", "12h"],
          ])}
        </Row>
      </section>
      <section className="settings-rows">
        <h3>{t("events")}</h3>
        <Row label={t("eventDetails")}>
          {select("eventDetails", [
            ["popover", t("popup")],
            ["panel", t("sidePanel")],
          ])}
        </Row>
        <Row label={t("defaultDuration")}>
          {select(
            "defaultDuration",
            [15, 30, 45, 60, 90].map((n) => [n, t("minutes", { n })]),
          )}
        </Row>
        <Row label={t("defaultCalendar")}>
          <select value={settings.defaultCalendarId ?? ""} onChange={(e) => update({ defaultCalendarId: e.target.value || undefined })}>
            <option value="">—</option>
            {calendars.filter(isWritable).map((c) => (
              <option key={c.id} value={c.id}>
                {calendarName(c)}
              </option>
            ))}
          </select>
        </Row>
      </section>
    </>
  );
}

function NotificationsPage() {
  const { t, settings, update } = useSettings();
  const [permission, setPermission] = useState<NotificationPermission>("granted");
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  useEffect(() => {
    notificationPermission().then(setPermission, () => setPermission("denied"));
    if (isTauri) getAutostart().then(setAutostartState, () => setAutostartState(false));
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

  const hint =
    settings.notifications && permission === "denied" ? t("notificationsBlocked") : undefined;

  return (
    <>
      <PageHeader title={isTauri ? t("notificationsDesktop") : t("notifications")} />
      <section className="settings-rows">
        <Row label={t("notifyBefore")} hint={hint}>
          {settings.notifications && permission === "default" && (
            <button className="text-button" onClick={() => toggleNotifications(true)}>
              {t("allowNotifications")}
            </button>
          )}
          <Switch checked={settings.notifications} onChange={(on) => void toggleNotifications(on)} />
        </Row>
      </section>
      {isTauri && (
        <section className="settings-rows">
          <h3>{t("desktop")}</h3>
          <Row label={t("launchAtStartup")}>
            <Switch checked={!!autostart} disabled={autostart === null} onChange={(on) => void toggleAutostart(on)} />
          </Row>
          <Row label={t("closeToTray")}>
            <Switch checked={settings.closeToTray} onChange={(on) => update({ closeToTray: on })} />
          </Row>
        </section>
      )}
    </>
  );
}

function ServerPage() {
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

  const connected = !!(status && typeof status === "object" && "connected" in status && status.connected);

  return (
    <>
      <PageHeader title={t("server")} hint={t("serverHint")} />
      <section className="settings-rows">
        <Row label={t("serverUrl")}>
          <input
            type="url"
            className="server-url"
            placeholder={isTauri ? "https://calendar.bayfield.dev" : location.origin}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => url !== settings.serverUrl && update({ serverUrl: url.trim() })}
          />
        </Row>
        <Row
          label={t("googleAccount")}
          hint={
            status === "checking"
              ? t("checking")
              : status && "error" in status
                ? status.error
                : connected
                  ? t("connectedAs", { email: (status as ServerStatus).email ?? "" })
                  : base
                    ? t("notConnected")
                    : t("serverNotConfigured")
          }
        >
          {base && status !== "checking" && !connected && (
            <button className="text-button" onClick={connect}>
              {t("connectGoogle")}
            </button>
          )}
        </Row>
      </section>
    </>
  );
}

function ShortcutsPage() {
  const { t } = useSettings();
  return (
    <>
      <PageHeader title={t("shortcuts")} />
      <ShortcutList />
    </>
  );
}

/** The app's version, and a way to look for a newer one. */
function AboutPage() {
  const { t, settings, update } = useSettings();
  const { state, check } = useUpdateCheck(false);
  const release = state.status === "available" ? state.release : null;
  useEffect(() => {
    void check();
  }, [check]);

  const status =
    state.status === "checking" || state.status === "idle"
      ? t("checkingUpdates")
      : state.status === "upToDate"
        ? t("upToDate")
        : state.status === "error"
          ? t("updateCheckFailed")
          : t("updateAvailable", { version: release?.version ?? "" });

  return (
    <>
      <PageHeader title={t("about")} />
      <section className="settings-rows">
        <Row label={t("appName")} hint={isTauri ? t("aboutDesktop") : t("aboutWeb")}>
          <span className="version-tag">{t("versionLabel", { version: APP_VERSION })}</span>
        </Row>
        <Row label={t("updates")} hint={status}>
          {release ? (
            <>
              <button className="text-button" onClick={() => openExternal(release.url)}>
                {t("whatsNew")}
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  if (settings.skippedUpdate === release.version) update({ skippedUpdate: "" });
                  openExternal(release.installer ?? release.url);
                }}
              >
                {t("download")}
              </button>
            </>
          ) : (
            <button className="text-button" disabled={state.status === "checking"} onClick={() => void check()}>
              {t("checkForUpdates")}
            </button>
          )}
        </Row>
        <Row label={t("releaseNotes")}>
          <button className="text-button" onClick={() => openExternal(RELEASES_URL)}>
            {t("openInBrowser")}
          </button>
        </Row>
      </section>
    </>
  );
}
