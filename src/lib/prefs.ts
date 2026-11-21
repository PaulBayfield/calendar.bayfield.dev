// Preferences shared with the other bayfield.dev apps, through prefs.bayfield.dev (the same file
// in every app). Each app keeps its own settings as before; the shared ones are also sent there
// when they change here, and changed here when they change in another app.
//
//  - Browser: prefs.bayfield.dev's cookie (same site as every *.bayfield.dev app).
//  - Desktop: a computer's token, approved once in the browser and kept in the OS credential
//    store (shared by the desktop apps on that computer): Rust commands prefs_token_get/_set
//    (src-tauri/src/prefs.rs). Desktop apps hand this file their Tauri functions at startup
//    (registerPrefsDesktop), so it builds in web-only apps too.
//
// No server of the app is involved, and no API key: it's the person's own session.

import { useEffect, useRef, useSyncExternalStore } from "react";

export const PREFS_URL: string = (import.meta.env.VITE_PREFS_URL as string | undefined) ?? "https://prefs.bayfield.dev";

// ---------- Custom themes ----------
//
// Made on prefs.bayfield.dev: a built-in theme (its base) with some of its colours replaced. One
// is in use when `customTheme` is its id and `theme` is still its base (choosing another theme
// anywhere takes it off). The same tables and function as prefs.bayfield.dev's public/assets/app.js.

export type ThemeBase = "light" | "dark" | "rosepine" | "rosepine-dawn";
export const THEME_COLORS = ["bg", "bg-sidebar", "bg-elevated", "bg-input", "text", "text-muted", "border-strong", "primary", "accent", "brand"] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];

export interface CustomTheme {
  id: string;
  name: string;
  base: ThemeBase;
  /** Only the colours that differ from the base ("#rrggbb"). */
  colors: Partial<Record<ThemeColor, string>>;
}

/** The built-in themes' values for those colours (for previews). */
export const BASE_COLORS: Record<ThemeBase, Record<ThemeColor, string>> = {
  light: { bg: "#ffffff", "bg-sidebar": "#f8f8f7", "bg-elevated": "#ffffff", "bg-input": "#f1f1ef", text: "#37352f", "text-muted": "#787774", "border-strong": "#e3e2e0", primary: "#2383e2", accent: "#eb5757", brand: "#2f9e74" },
  dark: { bg: "#191919", "bg-sidebar": "#202020", "bg-elevated": "#252525", "bg-input": "#2a2a2a", text: "#e9e9e7", "text-muted": "#9b9a97", "border-strong": "#343434", primary: "#2383e2", accent: "#eb5757", brand: "#3fb68b" },
  rosepine: { bg: "#191724", "bg-sidebar": "#1f1d2e", "bg-elevated": "#26233a", "bg-input": "#26233a", text: "#e0def4", "text-muted": "#908caa", "border-strong": "#403d52", primary: "#c4a7e7", accent: "#eb6f92", brand: "#9ccfd8" },
  "rosepine-dawn": { bg: "#faf4ed", "bg-sidebar": "#fffaf3", "bg-elevated": "#fffaf3", "bg-input": "#f2e9e1", text: "#575279", "text-muted": "#797593", "border-strong": "#dfdad9", primary: "#907aa9", accent: "#b4637a", brand: "#56949f" },
};

/** The custom theme in use, if any. */
export function activeCustomTheme(p: { theme?: string; customTheme?: string; customThemes?: CustomTheme[] }): CustomTheme | null {
  const theme = p.customThemes?.find((x) => x.id === p.customTheme);
  return theme && theme.base === p.theme ? theme : null;
}

/** Black or white, whichever reads better on `hex`. */
function onColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#111111" : "#ffffff";
}

/** The CSS variables a custom theme sets over its base: its colours, and the ones made from them. */
export function themeVars(theme: CustomTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  const c = theme.colors;
  for (const k of THEME_COLORS) if (c[k]) vars[`--${k}`] = c[k];
  const has = (...keys: ThemeColor[]) => keys.some((k) => c[k]);
  if (has("bg", "text")) {
    vars["--bg-subtle"] = "color-mix(in srgb, var(--bg) 97%, var(--text))";
    vars["--hover"] = "color-mix(in srgb, var(--text) 7%, transparent)";
    vars["--active"] = "color-mix(in srgb, var(--text) 11%, transparent)";
  }
  if (has("bg", "text-muted")) vars["--text-faint"] = "color-mix(in srgb, var(--text-muted) 62%, var(--bg))";
  if (has("bg", "border-strong")) vars["--border"] = "color-mix(in srgb, var(--border-strong) 55%, var(--bg))";
  if (c.primary) vars["--on-primary"] = onColor(c.primary);
  if (c.accent) vars["--on-accent"] = onColor(c.accent);
  if (c.brand) vars["--seq"] = c.brand;
  if (has("bg-input")) vars["--seq-empty"] = "var(--bg-input)";
  return vars;
}

/** The shared preferences (as in prefs.bayfield.dev's server/src/catalog.ts). */
export interface SharedPrefs {
  theme: "system" | "light" | "dark" | "rosepine" | "rosepine-dawn";
  customThemes: CustomTheme[];
  customTheme: string;
  language: "auto" | "en" | "fr";
  timeFormat: "auto" | "24h" | "12h";
  durationStyle: "long" | "short" | "decimal";
  globe: boolean;
  distanceUnit: "km" | "mi";
  weekStartsOn: 0 | 1;
  timeZone: string;
}
export type PrefKey = keyof SharedPrefs;
type Values = Partial<SharedPrefs>;

interface Remote {
  values: Values;
  updatedAt: Partial<Record<PrefKey, number>>;
}

/** What a desktop app gives this file (from @tauri-apps/api/core and @tauri-apps/plugin-opener). */
export interface PrefsDesktop {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  openUrl: (url: string) => Promise<void>;
}

let desktop: PrefsDesktop | null = null;

/** Desktop apps: call once at startup, before rendering. */
export function registerPrefsDesktop(d: PrefsDesktop) {
  desktop = d;
}

const isDesktop = () => desktop !== null;
/** What this app last saw of each shared value, and when it changed (survives reloads). */
const META_KEY = "bayfield.prefs.meta";

interface Meta {
  known: Values;
  updatedAt: Partial<Record<PrefKey, number>>;
}

function loadMeta(): Meta {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY) ?? "{}") as Partial<Meta>;
    return { known: m.known ?? {}, updatedAt: m.updatedAt ?? {} };
  } catch {
    return { known: {}, updatedAt: {} };
  }
}

function saveMeta(m: Meta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(m));
  } catch {
    // Not critical: at worst a value is sent again.
  }
}

// ---------- Connection state (for the Settings row) ----------

export type PrefsStatus = "checking" | "connected" | "disconnected" | "connecting" | "offline";

interface State {
  status: PrefsStatus;
  email: string | null;
}

let state: State = { status: "checking", email: null };
const watchers = new Set<() => void>();
function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  watchers.forEach((w) => w());
}

/** The connection, for a "Sync my preferences" row. */
export function usePrefsStatus(): State {
  return useSyncExternalStore(
    (w) => {
      watchers.add(w);
      return () => watchers.delete(w);
    },
    () => state,
  );
}

// ---------- Talking to prefs.bayfield.dev ----------

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) throw new Error("Not the desktop app");
  return desktop.invoke<T>(cmd, args);
}

/** Desktop: the computer's token, if it was connected. */
async function deviceToken(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    return await invoke<string | null>("prefs_token_get");
  } catch {
    return null;
  }
}

class Unauthorized extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await deviceToken();
  if (isDesktop() && !token) throw new Unauthorized();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(`${PREFS_URL}${path}`, { ...init, headers, credentials: isDesktop() ? "omit" : "include" });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`prefs.bayfield.dev answered ${res.status}`);
  return res.json() as Promise<T>;
}

// ---------- Connecting ----------

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let linking: AbortController | null = null;

/**
 * Connects this browser (a trip through prefs.bayfield.dev and back) or this computer (approved
 * in the browser; the app waits for it). `appName` names it in the list there, with the
 * computer's name: "Notes on PAUL-PC".
 */
export async function connectPrefs(appName: string): Promise<void> {
  if (!isDesktop()) {
    location.href = `${PREFS_URL}/api/auth/login?return=${encodeURIComponent(location.href)}`;
    return;
  }
  linking?.abort();
  const abort = new AbortController();
  linking = abort;
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const computer = await invoke<string>("prefs_computer_name").catch(() => "");
  const name = computer ? `${appName} on ${computer}` : appName;
  const url = `${PREFS_URL}/link?challenge=${await sha256Hex(secret)}&name=${encodeURIComponent(name)}`;
  await desktop!.openUrl(url);
  setState({ status: "connecting" });
  // Up to 10 minutes for the approval, asking every 2 seconds.
  for (let i = 0; i < 300 && !abort.signal.aborted; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${PREFS_URL}/v1/link/claim`, { headers: { "X-Link-Secret": secret }, signal: abort.signal }).catch(() => null);
    if (!res?.ok) continue;
    const { token } = (await res.json()) as { token: string };
    await invoke("prefs_token_set", { token });
    linking = null;
    reconnect();
    return;
  }
  if (!abort.signal.aborted) setState({ status: "disconnected" });
}

/** Signs this browser (every app in it) or this computer (its desktop apps) out of the sync. */
export async function disconnectPrefs(): Promise<void> {
  linking?.abort();
  await request("/api/auth/logout", { method: "POST" }).catch(() => {});
  if (isDesktop()) await invoke("prefs_token_set", { token: null }).catch(() => {});
  stopEvents();
  setState({ status: "disconnected", email: null });
}

// ---------- Syncing ----------

let reconnect: () => void = () => {};
let stopEvents: () => void = () => {};

/** By value: lists and objects (custom themes) come back as new objects from storage and the server. */
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Keeps the app's shared settings in step with prefs.bayfield.dev. Call once, at the top of the
 * app: `values` are the app's current values for the shared keys it has (others omitted), and
 * `apply` changes them (some may be kept on the app's own server: gps' time zone, say).
 */
export function usePrefsSync(values: Values, apply: (patch: Values) => void) {
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const meta = useRef<Meta>(loadMeta());
  const pending = useRef<Values>({});
  const connected = useRef(false);

  // Sends what changed here and hasn't been sent; takes in what's newer there.
  const flush = useRef(async () => {});
  flush.current = async () => {
    const keys = Object.keys(pending.current) as PrefKey[];
    if (!keys.length || !connected.current) return;
    const body: Record<string, { value: unknown; updatedAt: number }> = {};
    for (const k of keys) body[k] = { value: pending.current[k], updatedAt: meta.current.updatedAt[k] ?? Date.now() };
    try {
      const remote = await request<Remote>("/v1/preferences", { method: "PUT", body: JSON.stringify(body) });
      for (const k of keys) if (same(pending.current[k], body[k].value)) delete pending.current[k];
      take(remote);
    } catch (e) {
      if (e instanceof Unauthorized) setState({ status: "disconnected" });
      else setState({ status: "offline" });
    }
  };

  /** Applies the values that are newer there than here. */
  const take = (remote: Remote) => {
    const patch: Values = {};
    for (const k of Object.keys(valuesRef.current) as PrefKey[]) {
      const at = remote.updatedAt[k];
      if (at === undefined || remote.values[k] === undefined) continue;
      if (at <= (meta.current.updatedAt[k] ?? 0) || k in pending.current) continue;
      meta.current.updatedAt[k] = at;
      meta.current.known[k] = remote.values[k] as never;
      if (!same(valuesRef.current[k], remote.values[k])) (patch as Record<string, unknown>)[k] = remote.values[k];
    }
    saveMeta(meta.current);
    if (Object.keys(patch).length) applyRef.current(patch);
  };

  // A shared value changed here (in this app's own settings): stamp it and send it.
  const signature = JSON.stringify(values);
  useEffect(() => {
    let changed = false;
    for (const k of Object.keys(values) as PrefKey[]) {
      const v = values[k];
      if (v === undefined || same(meta.current.known[k], v)) continue;
      // The first time this app syncs a key, its value only fills a gap: it doesn't beat what
      // the other apps already chose (dated 0, any stored change is newer).
      const first = !(k in meta.current.known);
      meta.current.known[k] = v as never;
      meta.current.updatedAt[k] = first ? 0 : Date.now();
      (pending.current as Record<string, unknown>)[k] = v;
      changed = true;
    }
    if (changed) {
      saveMeta(meta.current);
      void flush.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    let cancelled = false;
    let retry = 0;
    let events: AbortController | null = null;

    const listen = async () => {
      events?.abort();
      const abort = new AbortController();
      events = abort;
      try {
        const token = await deviceToken();
        const res = await fetch(`${PREFS_URL}/v1/events`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: isDesktop() ? "omit" : "include",
          signal: abort.signal,
        });
        if (res.status === 401) return setState({ status: "disconnected" });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        retry = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (/^event: ?preferences$/m.test(block) && data) take(JSON.parse(data) as Remote);
          }
        }
      } catch {
        if (abort.signal.aborted) return;
      }
      if (cancelled || abort.signal.aborted) return;
      // Dropped (sleep, network): try again, waiting longer each time, up to a minute.
      retry = Math.min(retry + 1, 6);
      setTimeout(() => !cancelled && void start(), 1000 * 2 ** retry);
    };

    const start = async () => {
      try {
        const me = await request<{ email: string | null; name: string }>("/v1/me");
        if (cancelled) return;
        connected.current = true;
        setState({ status: "connected", email: me.email ?? me.name });
        take(await request<Remote>("/v1/preferences"));
        await flush.current();
        void listen();
      } catch (e) {
        connected.current = false;
        if (cancelled) return;
        if (e instanceof Unauthorized) setState({ status: "disconnected", email: null });
        else {
          setState({ status: "offline" });
          retry = Math.min(retry + 1, 6);
          setTimeout(() => !cancelled && void start(), 1000 * 2 ** retry);
        }
      }
    };

    reconnect = () => void start();
    stopEvents = () => {
      connected.current = false;
      events?.abort();
    };
    void start();
    // Back to the window: catch up (the live stream may have been cut while asleep).
    const onFocus = () => connected.current && void request<Remote>("/v1/preferences").then(take, () => {});
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      events?.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
