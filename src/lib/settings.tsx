import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { makeFormats, makeT, resolveLang, type Formats, type Lang, type Translate } from "./i18n";
import { isTauri } from "./auth";
import { activeCustomTheme, themeVars, type CustomTheme } from "./prefs";

export type Theme = "system" | "light" | "dark" | "rosepine" | "rosepine-dawn";

export interface Settings {
  theme: Theme;
  /** Custom themes, made on prefs.bayfield.dev and synced from there. */
  customThemes: CustomTheme[];
  /** The custom theme in use (its id), laid over `theme`; "" for none. */
  customTheme: string;
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
  /** Weather icon next to each day, from the scheduling server. */
  weather: boolean;
  /** City whose weather is shown; empty means the first one the server knows. */
  weatherCity: string;
  /** A new version the user chose not to be told about again. */
  skippedUpdate: string;
  /** Done tasks leave the board after this many days in the done column; 0 keeps them. */
  hideDoneAfter: number;
}

const STORAGE_KEY = "calendar.settings";
/** The custom theme's CSS variables, for index.html to set before the app loads (no flash). */
const THEME_VARS_KEY = "calendar.themeVars";

const DEFAULTS: Settings = {
  theme: "system",
  customThemes: [],
  customTheme: "",
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
  skippedUpdate: "",
  hideDoneAfter: 7,
  weather: false,
  weatherCity: "",
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

  // A custom theme: its colours over its base, plus the calendar's own shades made from them.
  const customKey = JSON.stringify(activeCustomTheme(settings));
  const customVars = useMemo(() => {
    const custom = JSON.parse(customKey) as CustomTheme | null;
    if (!custom) return {};
    const vars = themeVars(custom);
    if (custom.colors.bg || custom.colors.text) vars["--bg-weekend"] = "color-mix(in srgb, var(--bg) 97%, var(--text))";
    return vars;
  }, [customKey]);
  useEffect(() => {
    const root = document.documentElement.style;
    try {
      // What index.html set from the last session, if this theme no longer sets it.
      for (const k of Object.keys(JSON.parse(localStorage.getItem(THEME_VARS_KEY) ?? "{}") as object)) if (!(k in customVars)) root.removeProperty(k);
    } catch {
      // Nothing was set then.
    }
    for (const [k, v] of Object.entries(customVars)) root.setProperty(k, v);
    try {
      if (Object.keys(customVars).length) localStorage.setItem(THEME_VARS_KEY, JSON.stringify(customVars));
      else localStorage.removeItem(THEME_VARS_KEY);
    } catch {
      // Only the first paint uses it.
    }
    return () => {
      for (const k of Object.keys(customVars)) root.removeProperty(k);
    };
  }, [customVars]);
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
