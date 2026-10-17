import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { makeFormats, makeT, resolveLang, type Formats, type Lang, type Translate } from "./i18n";
import { isTauri } from "./auth";

export type Theme = "system" | "light" | "dark" | "rosepine" | "rosepine-dawn";

export interface Settings {
  theme: Theme;
  language: "auto" | Lang;
  weekStartsOn: 0 | 1;
  timeFormat: "auto" | "24h" | "12h";
  defaultDuration: number;
  defaultCalendarId?: string;
  /** Base URL of the scheduling server; empty on the web build means "same origin". */
  serverUrl: string;
  days: number;
  /** Day count used on phone-sized screens. */
  mobileDays: number;
  sidebar: boolean;
  /** Desktop sidebar width in pixels. */
  sidebarWidth: number;
  panel: boolean;
  eventDetails: "popover" | "panel";
  /** Blur event titles and calendar names, keeping only the colours visible. */
  privacy: boolean;
  /** Calendars toggled away from Google's default visibility. */
  toggledCalendars: string[];
  /** Calendar ids in the user's chosen order; unlisted calendars follow in Google's order. */
  calendarOrder: string[];
  /** System notifications for events' popup reminders. */
  notifications: boolean;
  /** Desktop: the close button hides the window to the tray instead of quitting. */
  closeToTray: boolean;
}

const STORAGE_KEY = "calendar.settings";

const DEFAULTS: Settings = {
  theme: "system",
  language: "auto",
  weekStartsOn: 1,
  timeFormat: "auto",
  defaultDuration: 30,
  serverUrl: isTauri ? (import.meta.env.VITE_API_URL ?? "") : "",
  days: 7,
  mobileDays: 3,
  sidebar: true,
  sidebarWidth: 248,
  panel: true,
  eventDetails: "popover",
  privacy: false,
  toggledCalendars: [],
  calendarOrder: [],
  notifications: true,
  closeToTray: true,
};

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

function save(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not critical.
  }
}

interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  t: Translate;
  f: Formats;
  lang: Lang;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(load);
  const [systemDark, setSystemDark] = useState(darkQuery.matches);

  useEffect(() => {
    const onChange = () => setSystemDark(darkQuery.matches);
    darkQuery.addEventListener("change", onChange);
    return () => darkQuery.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-privacy", settings.privacy);
  }, [settings.privacy]);

  const value = useMemo<SettingsContextValue>(() => {
    const lang = resolveLang(settings.language);
    document.documentElement.lang = lang;
    return {
      settings,
      update: (patch) =>
        setSettings((s) => {
          const next = { ...s, ...patch };
          save(next);
          return next;
        }),
      t: makeT(lang),
      f: makeFormats(lang, settings.timeFormat),
      lang,
    };
  }, [settings]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings outside SettingsProvider");
  return value;
}
