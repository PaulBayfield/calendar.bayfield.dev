import { useEffect, useRef } from "react";
import { isTauri } from "./auth";
import { listEvents, type CalEvent, type Calendar } from "./google";
import type { Formats, Translate } from "./i18n";

/** Far enough ahead for "1 week before" reminders; longer ones are rare and skipped. */
const LOOKAHEAD_MS = 8 * 24 * 3600_000;
const REFRESH_MS = 5 * 60_000;
const TICK_MS = 20_000;
/** A reminder this late still fires (e.g. after the machine wakes up); older ones are dropped. */
const GRACE_MS = 3 * 60_000;

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
    // Windows toasts can't call back into the app here; they just inform.
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

interface Options {
  calendars: Calendar[];
  enabled: boolean;
  privacy: boolean;
  t: Translate;
  f: Formats;
  onOpen: (ev: CalEvent) => void;
}

/** Shows a system notification for each popup reminder of the given calendars' events. */
export function useReminders({ calendars, enabled, privacy, t, f, onOpen }: Options) {
  // Latest values for the timers without restarting them on every render.
  const live = useRef({ privacy, t, f, onOpen });
  live.current = { privacy, t, f, onOpen };

  useEffect(() => {
    if (!enabled || !calendars.length) return;
    const startedAt = Date.now();
    const fired = new Set<string>();
    let reminders: { id: string; at: number; ev: CalEvent }[] = [];
    let cancelled = false;
    let lastRefresh = 0;

    const refresh = async () => {
      const now = Date.now();
      if (now - lastRefresh < 60_000 || (await notificationPermission()) !== "granted") return;
      lastRefresh = now;
      const results = await Promise.allSettled(
        calendars.map((c) => listEvents(c, new Date(now - GRACE_MS), new Date(now + LOOKAHEAD_MS))),
      );
      if (cancelled) return;
      reminders = results.flatMap((r) =>
        r.status === "fulfilled"
          ? r.value.flatMap((ev) =>
              reminderOffsets(ev).map((m) => ({ id: `${ev.key}@${ev.start.getTime()}-${m}`, at: ev.start.getTime() - m * 60_000, ev })),
            )
          : [],
      );
      tick();
    };

    const tick = () => {
      const now = Date.now();
      for (const r of reminders) {
        if (r.at > now || r.at <= Math.max(now - GRACE_MS, startedAt) || fired.has(r.id)) continue;
        fired.add(r.id);
        const { privacy, t, f, onOpen } = live.current;
        const ev = r.ev;
        const mins = Math.round((ev.start.getTime() - now) / 60_000);
        const when = ev.allDay ? f.shortDate(ev.start) : `${f.time(ev.start)} – ${f.time(ev.end)}`;
        const soon = mins <= 0 ? t("startsNow") : t("startsIn", { n: mins });
        const title = privacy ? t("event") : ev.title || t("untitled");
        const place = privacy ? undefined : ev.event.location;
        notify(title, [ev.allDay ? when : `${soon} · ${when}`, place].filter(Boolean).join("\n"), () => onOpen(ev));
      }
    };

    refresh();
    const refreshTimer = setInterval(refresh, REFRESH_MS);
    const tickTimer = setInterval(tick, TICK_MS);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
      clearInterval(tickTimer);
      window.removeEventListener("focus", refresh);
    };
  }, [calendars, enabled]);
}
