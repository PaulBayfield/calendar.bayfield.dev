import { useEffect, useRef } from "react";
import { isTauri } from "./auth";
import { addDays, parseDateOnly, startOfDay } from "./dates";
import { listEvents, type CalEvent, type Calendar } from "./google";
import type { Formats, Translate } from "./i18n";

/** Far enough ahead for "1 week before" reminders; longer ones are rare and skipped. */
const LOOKAHEAD_MS = 8 * 24 * 3600_000;
const REFRESH_MS = 5 * 60_000;
const TICK_MS = 20_000;
/** A reminder this late still fires (e.g. after the machine wakes up); older ones are dropped. */
const GRACE_MS = 3 * 60_000;
const TRAY_EVENTS = 5;

/** Minutes before the start for each popup reminder, the way Google Calendar would notify. */
export function reminderOffsets(ev: CalEvent): number[] {
  if (ev.declined) return [];
  const r = ev.event.reminders;
  const list = !r || r.useDefault ? ev.calendar.defaultReminders : r.overrides;
  return (list ?? []).filter((x) => x.method === "popup").map((x) => x.minutes);
}

export type NotificationPermission = "granted" | "denied" | "default";

export async function notificationPermission(request = false): Promise<NotificationPermission> {
  if (isTauri) {
    const n = await import("@tauri-apps/plugin-notification");
    if (await n.isPermissionGranted()) return "granted";
    return request ? n.requestPermission() : "default";
  }
  if (!("Notification" in window)) return "denied";
  if (Notification.permission !== "default" || !request) return Notification.permission;
  return Notification.requestPermission();
}

async function notify(title: string, body: string, onClick: () => void) {
  if (isTauri) {
    // Windows toasts can't call back into the app here; the tray menu opens events instead.
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title, body });
    return;
  }
  const n = new Notification(title, { body, icon: "/favicon.svg", tag: title + body });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

/** Tray menu line: "14:00  Lunch with Sam", "Demain 09:00  Standup"… */
function trayLabel(ev: CalEvent, now: number, privacy: boolean, t: Translate, f: Formats): string {
  const today = startOfDay(new Date(now));
  const day =
    ev.start < addDays(today, 1) ? "" : ev.start < addDays(today, 2) ? `${t("tomorrow")} ` : `${f.weekday(ev.start)} `;
  const when = ev.start.getTime() <= now ? t("ongoing") : `${day}${f.time(ev.start)}`;
  const title = privacy ? t("event") : ev.title || t("untitled");
  const short = title.length > 40 ? `${title.slice(0, 39)}…` : title;
  // "&" marks a keyboard accelerator in Windows menus.
  return `${when}  ${short}`.replace(/&/g, "&&");
}

async function setTrayEvents(events: { key: string; label: string }[] | null) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_tray_events", { events });
}

interface Options {
  calendars: Calendar[];
  /** The app's loaded weeks: fresher than the background fetch (local edits, deletions). */
  chunks: Record<string, CalEvent[]>;
  notifications: boolean;
  privacy: boolean;
  t: Translate;
  f: Formats;
  onOpen: (ev: CalEvent) => void;
}

/**
 * Watches the coming week of the given calendars: shows a system notification for each popup
 * reminder, and on desktop lists the next events in the tray menu (clicking one opens it).
 */
export function useUpcoming({ calendars, chunks, notifications, privacy, t, f, onOpen }: Options) {
  // Latest values for the timers without restarting them on every render.
  const live = useRef({ chunks, privacy, t, f, onOpen });
  live.current = { chunks, privacy, t, f, onOpen };
  const tickRef = useRef<() => void>(undefined);

  useEffect(() => {
    if (!calendars.length || !(notifications || isTauri)) return;
    const shown = new Set(calendars.map((c) => c.id));
    const startedAt = Date.now();
    const fired = new Set<string>();
    let fetched: CalEvent[] = [];
    let byKey = new Map<string, CalEvent>();
    let lastTray = "";
    let canNotify = false;
    let cancelled = false;
    let lastRefresh = 0;

    /** Background fetch, with the app's loaded weeks taking precedence where they cover. */
    const merged = (): CalEvent[] => {
      const { chunks } = live.current;
      const covered = Object.keys(chunks).map((k) => [parseDateOnly(k).getTime(), addDays(parseDateOnly(k), 7).getTime()]);
      const isCovered = (ev: CalEvent) => covered.some(([s, e]) => ev.start.getTime() >= s && ev.start.getTime() < e);
      const map = new Map<string, CalEvent>();
      for (const ev of fetched) if (!isCovered(ev)) map.set(ev.key, ev);
      for (const list of Object.values(chunks)) for (const ev of list) if (shown.has(ev.calendar.id)) map.set(ev.key, ev);
      return [...map.values()];
    };

    const tick = () => {
      const now = Date.now();
      const { privacy, t, f, onOpen } = live.current;
      const events = merged();

      if (notifications && canNotify) {
        for (const ev of events) {
          for (const m of reminderOffsets(ev)) {
            const at = ev.start.getTime() - m * 60_000;
            const id = `${ev.key}@${ev.start.getTime()}-${m}`;
            if (at > now || at <= Math.max(now - GRACE_MS, startedAt) || fired.has(id)) continue;
            fired.add(id);
            const mins = Math.round((ev.start.getTime() - now) / 60_000);
            const when = ev.allDay ? f.shortDate(ev.start) : `${f.time(ev.start)} – ${f.time(ev.end)}`;
            const soon = mins <= 0 ? t("startsNow") : t("startsIn", { n: mins });
            const title = privacy ? t("event") : ev.title || t("untitled");
            const place = privacy ? undefined : ev.event.location;
            notify(title, [ev.allDay ? when : `${soon} · ${when}`, place].filter(Boolean).join("\n"), () => onOpen(ev));
          }
        }
      }

      if (isTauri) {
        const next = events
          .filter((ev) => !ev.allDay && !ev.declined && ev.end.getTime() > now)
          .sort((a, b) => a.start.getTime() - b.start.getTime())
          .slice(0, TRAY_EVENTS);
        byKey = new Map(next.map((ev) => [ev.key, ev]));
        const items = next.map((ev) => ({ key: ev.key, label: trayLabel(ev, now, privacy, t, f) }));
        const json = JSON.stringify(items);
        if (json !== lastTray) {
          lastTray = json;
          void setTrayEvents(items);
        }
      }
    };
    tickRef.current = tick;

    const refresh = async () => {
      const now = Date.now();
      if (now - lastRefresh < 60_000) return;
      lastRefresh = now;
      canNotify = notifications && (await notificationPermission()) === "granted";
      if (!canNotify && !isTauri) return;
      const results = await Promise.allSettled(
        calendars.map((c) => listEvents(c, new Date(now - GRACE_MS), new Date(now + LOOKAHEAD_MS))),
      );
      if (cancelled) return;
      fetched = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      tick();
    };

    // Tray click → open that event in the window (Rust shows and focuses it).
    let unlisten: (() => void) | undefined;
    if (isTauri)
      import("@tauri-apps/api/event").then(({ listen }) =>
        listen<string>("tray-open-event", (e) => {
          const ev = byKey.get(e.payload);
          if (ev) live.current.onOpen(ev);
        }).then((fn) => (cancelled ? fn() : (unlisten = fn))),
      );

    refresh();
    const refreshTimer = setInterval(refresh, REFRESH_MS);
    const tickTimer = setInterval(tick, TICK_MS);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      tickRef.current = undefined;
      clearInterval(refreshTimer);
      clearInterval(tickTimer);
      window.removeEventListener("focus", refresh);
      unlisten?.();
      if (isTauri) void setTrayEvents(null);
    };
  }, [calendars, notifications]);

  // Local edits show up in the tray (and reschedule reminders) without waiting for a tick.
  useEffect(() => {
    tickRef.current?.();
  }, [chunks, privacy, t]);
}
