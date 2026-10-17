import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthRequiredError, isTauri, preloadSignIn, restoreSession, signIn, signOut } from "./lib/auth";
import {
  createEvent,
  deleteEvent,
  eventTimes,
  isWritable,
  listCalendars,
  listEvents,
  moveEvent,
  toCalEvent,
  updateEvent,
  updateSeries,
  deleteSeries,
  isRecurring,
  canEdit,
  type RecurrenceScope,
  type CalEvent,
  type Calendar,
  type EventInput,
  type GoogleEvent,
} from "./lib/google";
import type { Slot } from "./lib/server";
import { addDays, addMinutes, atMinute, minuteOfDay, parseDateOnly, startOfDay, startOfWeek, toDateOnly } from "./lib/dates";
import { SettingsProvider, useSettings } from "./lib/settings";
import { MOBILE_QUERY, useMediaQuery } from "./lib/useMediaQuery";
import { useUpcoming } from "./lib/reminders";
import { useDesktopSync } from "./lib/desktop";
import { shiftEvent, WeekView } from "./components/WeekView";
import { Sidebar } from "./components/Sidebar";
import { MAX_DAYS, Toolbar, WindowControls } from "./components/Toolbar";
import { EventPanel } from "./components/EventPanel";
import { EventPopover } from "./components/EventPopover";
import { SchedulePanel } from "./components/SchedulePanel";
import { Shortcuts } from "./components/Shortcuts";
import { SettingsDialog } from "./components/SettingsDialog";
import { ContextMenu, type MenuTarget } from "./components/ContextMenu";
import { SelectionBar } from "./components/SelectionBar";
import { RecurrenceDialog } from "./components/RecurrenceDialog";
import { SearchDialog } from "./components/SearchDialog";

const REFRESH_MS = 5 * 60 * 1000;
const FOCUS_REFRESH_MS = 60 * 1000;
const HISTORY_LIMIT = 100;

/** One undoable step: how to reverse it, and how to apply it again. */
interface HistoryEntry {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** The fields `patch` touches, set back to their values in `before`. */
function inversePatch(before: CalEvent, patch: EventInput): EventInput {
  const e = before.event;
  const inverse: EventInput = {};
  if (patch.start || patch.end) Object.assign(inverse, eventTimes(before.start, before.end, before.allDay));
  if ("summary" in patch) inverse.summary = e.summary ?? "";
  if ("description" in patch) inverse.description = e.description ?? "";
  if ("location" in patch) inverse.location = e.location ?? "";
  if ("colorId" in patch) inverse.colorId = e.colorId ?? null;
  if ("transparency" in patch) inverse.transparency = e.transparency ?? "opaque";
  if ("reminders" in patch)
    inverse.reminders = e.reminders?.useDefault === false ? { useDefault: false, overrides: e.reminders.overrides ?? [] } : { useDefault: true, overrides: [] };
  if ("visibility" in patch) inverse.visibility = e.visibility === "public" || e.visibility === "private" ? e.visibility : "default";
  if ("attendees" in patch) inverse.attendees = e.attendees ?? [];
  return inverse;
}

const UNDO_MS = 5000;

export default function App() {
  return (
    <SettingsProvider>
      <Root />
    </SettingsProvider>
  );
}

type Status = "loading" | "signedOut" | "ready";

function Root() {
  const { settings, t } = useSettings();
  useDesktopSync(settings.closeToTray, t);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback((e: unknown) => {
    if (e instanceof AuthRequiredError) setStatus("signedOut");
    else setError(e instanceof Error ? e.message : String(e));
  }, []);

  useEffect(() => {
    restoreSession()
      .then((ok) => setStatus(ok ? "ready" : "signedOut"))
      .catch((e) => {
        handleError(e);
        setStatus("signedOut");
      });
  }, [handleError]);

  if (status === "loading") return <div className="splash" />;
  if (status === "signedOut")
    return (
      <SignIn
        error={error}
        onSignIn={async () => {
          setError(null);
          try {
            await signIn();
            setStatus("ready");
          } catch (e) {
            handleError(e);
          }
        }}
      />
    );
  return (
    <CalendarApp
      onError={handleError}
      error={error}
      onDismissError={() => setError(null)}
      onSignOut={async () => {
        await signOut().catch(handleError);
        setStatus("signedOut");
      }}
    />
  );
}

function SignIn({ error, onSignIn }: { error: string | null; onSignIn: () => Promise<void> }) {
  const { t } = useSettings();
  const [busy, setBusy] = useState(false);
  useEffect(() => void preloadSignIn()?.catch(() => {}), []);
  return (
    <div className="signin" data-tauri-drag-region>
      {isTauri && (
        <div className="signin-controls">
          <WindowControls />
        </div>
      )}
      <div className="signin-card">
        <img className="signin-logo" src="/favicon.svg" alt="" />
        <h1>Calendar</h1>
        <p className="muted">{t("signinHint")}</p>
        <button
          className="primary-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onSignIn();
            setBusy(false);
          }}
        >
          {busy ? t("waitingGoogle") : t("continueGoogle")}
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}

interface CalendarAppProps {
  onError: (e: unknown) => void;
  error: string | null;
  onDismissError: () => void;
  onSignOut: () => void;
}

/** Events are cached in Monday-aligned week chunks so day-by-day scrolling reuses them. */
function chunkKeys(start: Date, end: Date): string[] {
  const keys: string[] = [];
  for (let d = startOfWeek(start, 1); d < end; d = addDays(d, 7)) keys.push(toDateOnly(d));
  return keys;
}

function overlapsChunk(ev: CalEvent, key: string): boolean {
  const start = parseDateOnly(key);
  return ev.start < addDays(start, 7) && (ev.end > start || ev.start >= start);
}

function sameCalendars(a: Calendar[], b: Calendar[]): boolean {
  const sig = (cs: Calendar[]) => cs.map((c) => `${c.id}|${c.backgroundColor}|${c.selected}|${c.accessRole}|${calendarLabel(c)}`).join();
  return sig(a) === sig(b);
}
const calendarLabel = (c: Calendar) => c.summaryOverride ?? c.summary;

function CalendarApp({ onError, error, onDismissError, onSignOut }: CalendarAppProps) {
  const { t, f, settings, update } = useSettings();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const maxDays = mobile ? 7 : MAX_DAYS;
  const days = Math.min(maxDays, Math.max(1, mobile ? settings.mobileDays : settings.days));
  const setDays = (n: number) => update(mobile ? { mobileDays: n } : { days: n });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleSidebar = () => (mobile ? setDrawerOpen((o) => !o) : update({ sidebar: !settings.sidebar }));
  /** On phones, close the drawer after acting in it. */
  const fromDrawer = (fn: () => void) => () => {
    fn();
    if (mobile) setDrawerOpen(false);
  };
  const alignStart = useCallback(
    (d: Date) => (days >= 7 ? startOfWeek(d, settings.weekStartsOn) : startOfDay(d)),
    [days, settings.weekStartsOn],
  );

  const [rangeStart, setRangeStart] = useState(() => alignStart(new Date()));
  const [now, setNow] = useState(() => new Date());
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [chunks, setChunks] = useState<Record<string, CalEvent[]>>({});
  const [pending, setPending] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<CalEvent | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo?: () => void } | null>(null);
  const loaded = useRef(new Set<string>());
  const wide = useMediaQuery("(min-width: 1000px)");

  const rangeEnd = useMemo(() => addDays(rangeStart, days), [rangeStart, days]);
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => addDays(rangeStart, i)), [rangeStart, days]);

  // Re-align when the number of days or the week start changes, keeping today in view if it was.
  const prevLayout = useRef({ days, weekStartsOn: settings.weekStartsOn });
  useEffect(() => {
    const prev = prevLayout.current;
    if (prev.days === days && prev.weekStartsOn === settings.weekStartsOn) return;
    const today = startOfDay(new Date());
    const prevEnd = addDays(rangeStart, prev.days);
    setRangeStart(alignStart(today >= rangeStart && today < prevEnd ? today : rangeStart));
    prevLayout.current = { days, weekStartsOn: settings.weekStartsOn };
  }, [days, settings.weekStartsOn, alignStart, rangeStart]);

  // The user's sidebar order, used by every calendar list in the UI.
  const orderedCalendars = useMemo(() => {
    const rank = new Map(settings.calendarOrder.map((id, i) => [id, i]));
    return calendars
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (rank.get(a.c.id) ?? Infinity) - (rank.get(b.c.id) ?? Infinity) || a.i - b.i)
      .map(({ c }) => c);
  }, [calendars, settings.calendarOrder]);

  // Hidden = Google's unselected calendars, XOR the ones toggled here.
  const hidden = useMemo(() => {
    const toggled = new Set(settings.toggledCalendars);
    return new Set(calendars.filter((c) => (c.selected === false) !== toggled.has(c.id)).map((c) => c.id));
  }, [calendars, settings.toggledCalendars]);
  // Only these are fetched: every calendar costs one API request per week loaded.
  const shownCalendars = useMemo(() => calendars.filter((c) => !hidden.has(c.id)), [calendars, hidden]);

  const toggleCalendar = (id: string) => {
    const toggled = new Set(settings.toggledCalendars);
    if (toggled.has(id)) toggled.delete(id);
    else toggled.add(id);
    update({ toggledCalendars: [...toggled] });
  };

  // Clock for the now-line, plus periodic and on-focus refreshes.
  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 30_000);
    let lastRefresh = Date.now();
    const tick = () => {
      lastRefresh = Date.now();
      setRefreshTick((n) => n + 1);
    };
    const refresh = setInterval(tick, REFRESH_MS);
    const onFocus = () => {
      setNow(new Date());
      // Alt-tabbing back and forth shouldn't refetch every time (API quota is per minute).
      if (Date.now() - lastRefresh > FOCUS_REFRESH_MS) tick();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(clock);
      clearInterval(refresh);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    listCalendars()
      .then((next) => setCalendars((prev) => (sameCalendars(prev, next) ? prev : next)))
      .catch(onError);
  }, [onError, refreshTick]);

  const loadChunks = useCallback(
    async (keys: string[], force: boolean) => {
      // Tracked per week *and* calendar, so showing a calendar fetches just that one.
      const todo = keys.flatMap((k) =>
        shownCalendars.filter((c) => force || !loaded.current.has(`${k}|${c.id}`)).map((c) => ({ k, c })),
      );
      if (!todo.length) return;
      todo.forEach(({ k, c }) => loaded.current.add(`${k}|${c.id}`));
      setPending((n) => n + 1);
      const results = await Promise.allSettled(
        todo.map(async ({ k, c }) => {
          const start = parseDateOnly(k);
          return { k, c, events: await listEvents(c, start, addDays(start, 7)) };
        }),
      );
      setChunks((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          const { k, c, events } = r.value;
          next[k] = [...(next[k] ?? []).filter((e) => e.calendar.id !== c.id), ...events];
        }
        return next;
      });
      results.forEach((r, i) => r.status === "rejected" && loaded.current.delete(`${todo[i].k}|${todo[i].c.id}`));
      const failed = results.find((r) => r.status === "rejected");
      if (failed) onError(failed.reason);
      setPending((n) => n - 1);
    },
    [shownCalendars, onError],
  );

  // New calendar list → start over.
  useEffect(() => {
    loaded.current.clear();
    setChunks({});
  }, [calendars]);

  // Load the visible range plus a week either side, so scrolling feels instant.
  useEffect(() => {
    void loadChunks(chunkKeys(addDays(rangeStart, -7), addDays(rangeEnd, 7)), false);
  }, [loadChunks, rangeStart, rangeEnd]);

  useEffect(() => {
    if (refreshTick) void loadChunks(chunkKeys(rangeStart, rangeEnd), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const knownEvents = useMemo(() => {
    const byKey = new Map<string, CalEvent>();
    for (const list of Object.values(chunks)) for (const ev of list) byKey.set(ev.key, ev);
    return [...byKey.values()];
  }, [chunks]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [focus, setFocus] = useState<{ time: Date; seq: number }>();
  /** Jump to an event found by search and open it. */
  const openFromSearch = (ev: CalEvent) => {
    setSearchOpen(false);
    setRangeStart(alignStart(ev.start));
    putEvent(null, ev);
    setDraft(null);
    setExtraKeys([]);
    setSelectedKey(ev.key);
    setFocus((f) => ({ time: ev.start, seq: (f?.seq ?? 0) + 1 }));
  };

  useUpcoming({ calendars: shownCalendars, chunks, notifications: settings.notifications, privacy: settings.privacy, t, f, onOpen: openFromSearch });

  const visibleEvents = useMemo(() => {
    const byKey = new Map<string, CalEvent>();
    for (const k of chunkKeys(rangeStart, rangeEnd))
      for (const ev of chunks[k] ?? []) if (!hidden.has(ev.calendar.id)) byKey.set(ev.key, ev);
    if (draft) byKey.set(draft.key, draft);
    return [...byKey.values()];
  }, [chunks, rangeStart, rangeEnd, hidden, draft]);

  const selectedEvent = useMemo(() => {
    if (!selectedKey) return null;
    if (selectedKey === draft?.key) return draft;
    for (const list of Object.values(chunks)) {
      const found = list.find((e) => e.key === selectedKey);
      if (found) return found;
    }
    return null;
  }, [selectedKey, draft, chunks]);

  /** Live times of the event being dragged on the grid, so its details follow the pointer. */
  const [dragPreview, setDragPreview] = useState<{ key: string; start: Date; end: Date } | null>(null);
  const shownEvent = useMemo(
    () =>
      selectedEvent && dragPreview?.key === selectedEvent.key
        ? { ...selectedEvent, start: dragPreview.start, end: dragPreview.end }
        : selectedEvent,
    [selectedEvent, dragPreview],
  );

  /** Replaces/removes an event in every cached chunk it touches. */
  const putEvent = useCallback((removeKey: string | null, ev: CalEvent | null) => {
    setChunks((prev) => {
      const next: Record<string, CalEvent[]> = {};
      for (const [k, list] of Object.entries(prev)) {
        const kept = list.filter((e) => e.key !== removeKey && e.key !== ev?.key);
        next[k] = ev && overlapsChunk(ev, k) ? [...kept, ev] : kept;
      }
      return next;
    });
  }, []);

  // --- Event actions ---

  const defaultCalendar = useMemo(() => {
    const writable = calendars.filter(isWritable);
    return writable.find((c) => c.id === settings.defaultCalendarId) ?? writable.find((c) => c.primary) ?? writable[0];
  }, [calendars, settings.defaultCalendarId]);

  const startDraft = (start: Date, end: Date, allDay: boolean) => {
    if (!defaultCalendar) return;
    setScheduling(false);
    setDraft({
      key: "draft",
      calendar: defaultCalendar,
      event: { id: "", status: "confirmed", htmlLink: "", start: {}, end: {} },
      title: "",
      start,
      end,
      allDay,
      color: defaultCalendar.backgroundColor,
      declined: false,
    });
    selectOnly("draft");
  };

  /** Events added with Ctrl/Shift+click, on top of `selectedKey` (the one whose details show). */
  const [extraKeys, setExtraKeys] = useState<string[]>([]);
  const selectedKeys = useMemo(
    () => new Set([...(selectedKey ? [selectedKey] : []), ...extraKeys]),
    [selectedKey, extraKeys],
  );
  const selectedEvents = useMemo(() => {
    const byKey = new Map<string, CalEvent>();
    for (const list of Object.values(chunks)) for (const ev of list) if (selectedKeys.has(ev.key)) byKey.set(ev.key, ev);
    if (draft && selectedKeys.has(draft.key)) byKey.set(draft.key, draft);
    return [...selectedKeys].flatMap((k) => byKey.get(k) ?? []);
  }, [chunks, draft, selectedKeys]);
  const multi = selectedEvents.length > 1;

  const selectOnly = (key: string | null) => {
    setExtraKeys([]);
    setSelectedKey(key);
  };
  const selectMany = (keys: string[]) => {
    setDraft(null);
    setSelectedKey(keys[0] ?? null);
    setExtraKeys(keys.slice(1));
  };

  /** Plain click selects one event; Ctrl/Shift+click toggles it in the selection. */
  const select = (ev: CalEvent | null, additive = false) => {
    if (ev?.key !== "draft") setDraft(null);
    if (!additive || !ev || ev.key === "draft" || !selectedKey || selectedKey === "draft") return selectOnly(ev?.key ?? null);
    if (ev.key === selectedKey) {
      const [next, ...rest] = extraKeys;
      setSelectedKey(next ?? null);
      setExtraKeys(rest);
    } else if (extraKeys.includes(ev.key)) setExtraKeys(extraKeys.filter((k) => k !== ev.key));
    else setExtraKeys([...extraKeys, ev.key]);
  };

  /** The selection if the event is part of a multi-selection, else just the event. */
  const groupFor = (ev: CalEvent): CalEvent[] =>
    multi && selectedKeys.has(ev.key) ? selectedEvents.filter((e) => e.key !== "draft") : [ev];

  // --- Undo / redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y) ---

  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  /** True while an undo/redo runs, so the changes it makes aren't recorded again. */
  const replaying = useRef(false);
  const batchRef = useRef<HistoryEntry[] | null>(null);
  const chunksRef = useRef(chunks);
  chunksRef.current = chunks;

  /** The current version of an event: later edits may have replaced the one a history entry captured. */
  const latest = (ev: CalEvent): CalEvent => {
    for (const list of Object.values(chunksRef.current)) {
      const found = list.find((e) => e.key === ev.key);
      if (found) return found;
    }
    return ev;
  };

  const combine = (entries: HistoryEntry[]): HistoryEntry =>
    entries.length === 1
      ? entries[0]
      : {
          undo: async () => {
            for (const e of [...entries].reverse()) await e.undo();
          },
          redo: async () => {
            for (const e of entries) await e.redo();
          },
        };

  const record = (entry: HistoryEntry) => {
    if (replaying.current) return;
    if (batchRef.current) return void batchRef.current.push(entry);
    undoStack.current.push(entry);
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
  };

  /** Records what `fn` does synchronously as a single undo step (e.g. moving several events). */
  const batch = (fn: () => void) => {
    const outer = batchRef.current;
    batchRef.current = [];
    try {
      fn();
    } finally {
      const entries = batchRef.current;
      batchRef.current = outer;
      if (entries.length) record(combine(entries));
    }
  };

  const replay = async (kind: "undo" | "redo") => {
    const [from, to] = kind === "undo" ? [undoStack, redoStack] : [redoStack, undoStack];
    const entry = from.current.pop();
    if (!entry) return;
    replaying.current = true;
    try {
      await entry[kind]();
      to.current.push(entry);
      setDetailsRevision((n) => n + 1); // An open popup shows the restored values.
      flash(t(kind === "undo" ? "undone" : "redone"));
    } catch (e) {
      onError(e);
    } finally {
      replaying.current = false;
    }
  };

  /** Brings back a deleted event. Same id, so older history entries still find it. */
  const restoreEvent = async (ev: CalEvent) => {
    putEvent(null, ev);
    putEvent(ev.key, await updateEvent(ev, { status: "confirmed" }));
  };
  const deleteNow = async (ev: CalEvent) => {
    putEvent(ev.key, null);
    await deleteEvent(ev);
  };
  const createdEntry = (ev: CalEvent): HistoryEntry => ({
    undo: () => deleteNow(latest(ev)),
    redo: () => restoreEvent(ev),
  });

  const saveDraft = async (calendar: Calendar, input: EventInput) => {
    try {
      const created = await createEvent(calendar, input);
      putEvent(null, created);
      record(createdEntry(created));
      setDraft(null);
      selectOnly(created.key);
    } catch (e) {
      onError(e);
    }
  };

  // --- Recurring events: ask which occurrences a change applies to ---

  const [scopeAsk, setScopeAsk] = useState<{ kind: "edit" | "delete"; resolve: (s: RecurrenceScope | null) => void } | null>(null);
  // Bumped when the dialog is cancelled, so the details form drops the edit that wasn't saved.
  const [detailsRevision, setDetailsRevision] = useState(0);
  const askScope = (kind: "edit" | "delete") =>
    new Promise<RecurrenceScope | null>((resolve) =>
      setScopeAsk({
        kind,
        resolve: (scope) => {
          if (!scope) setDetailsRevision((n) => n + 1);
          resolve(scope);
        },
      }),
    );

  /** After a series-wide change many occurrences moved: refetch what's cached. */
  const reloadAll = () => {
    loaded.current.clear();
    void loadChunks(chunkKeys(addDays(rangeStart, -7), addDays(rangeEnd, 7)), true);
  };

  /**
   * Updates events, asking once for the recurrence scope if any of them repeat. With "following" or
   * "all", each series is changed once even if several of its occurrences are in `evs`.
   */
  const updateMany = async (evs: CalEvent[], patchFor: (ev: CalEvent) => EventInput) => {
    const scope = evs.some(isRecurring) ? await askScope("edit") : "this";
    if (!scope) return;
    const seen = new Set<string>();
    batch(() => {
      for (const ev of evs) {
        if (scope !== "this" && isRecurring(ev)) {
          if (seen.has(ev.event.recurringEventId!)) continue;
          seen.add(ev.event.recurringEventId!);
        }
        void applyUpdate(ev, patchFor(ev), scope);
      }
    });
  };

  const applyUpdate = async (ev: CalEvent, patch: EventInput, knownScope?: RecurrenceScope) => {
    if (isRecurring(ev)) {
      const scope = knownScope ?? (await askScope("edit"));
      if (!scope) return;
      if (scope !== "this") {
        try {
          await updateSeries(ev, patch, scope);
          reloadAll();
        } catch (e) {
          onError(e);
        }
        return;
      }
    }
    const inverse = inversePatch(ev, patch);
    if (Object.keys(inverse).length)
      record({
        undo: () => applyUpdate(latest(ev), inverse, "this"),
        redo: () => applyUpdate(latest(ev), patch, "this"),
      });
    const { conferenceData, ...rest } = patch;
    const optimistic = toCalEvent(ev.calendar, {
      ...ev.event,
      ...rest,
      colorId: patch.colorId === null ? undefined : (patch.colorId ?? ev.event.colorId),
    } as GoogleEvent);
    if (optimistic && !conferenceData) putEvent(ev.key, optimistic);
    try {
      putEvent(ev.key, await updateEvent(ev, patch));
    } catch (e) {
      putEvent(ev.key, ev);
      onError(e);
    }
  };

  const moveTo = (ev: CalEvent, start: Date, end: Date) => {
    if (ev.key === "draft") setDraft({ ...ev, start, end });
    else void applyUpdate(ev, eventTimes(start, end, ev.allDay));
  };

  const shiftAll = (evs: CalEvent[], deltaMs: number) =>
    void updateMany(evs, (ev) => {
      const moved = shiftEvent(ev, deltaMs);
      return eventTimes(moved.start, moved.end, ev.allDay);
    });

  const changeCalendar = async (ev: CalEvent, calendar: Calendar) => {
    try {
      const moved = await moveEvent(ev, calendar);
      putEvent(ev.key, moved);
      record({
        undo: async () => {
          const current = latest(moved);
          putEvent(current.key, await moveEvent(current, ev.calendar));
        },
        redo: async () => {
          const current = latest(ev);
          putEvent(current.key, await moveEvent(current, calendar));
        },
      });
      selectOnly(moved.key);
    } catch (e) {
      onError(e);
    }
  };

  /** Removes events right away; Google is only told once the undo window has passed. */
  const pendingDelete = useRef<{ timer: ReturnType<typeof setTimeout>; commit: () => void; cancel: () => void; evs: CalEvent[] } | null>(null);
  const remove = async (input: CalEvent | CalEvent[], knownScope?: RecurrenceScope) => {
    let evs = (Array.isArray(input) ? input : [input]).filter((e) => e.key !== "draft" && canEdit(e));
    if (!evs.length) return;
    if (evs.some(isRecurring)) {
      const scope = knownScope ?? (await askScope("delete"));
      if (!scope) return;
      if (scope !== "this") {
        // Series deletions go straight to Google (the dialog was the confirmation); the rest get the undo toast.
        const seen = new Set<string>();
        try {
          for (const ev of evs.filter(isRecurring)) {
            if (seen.has(ev.event.recurringEventId!)) continue;
            seen.add(ev.event.recurringEventId!);
            await deleteSeries(ev, scope);
          }
        } catch (e) {
          onError(e);
        }
        selectOnly(null);
        reloadAll();
        evs = evs.filter((e) => !isRecurring(e));
        if (!evs.length) return;
      }
    }
    pendingDelete.current?.commit();
    for (const ev of evs) putEvent(ev.key, null);
    selectOnly(null);
    const commit = () => {
      clearTimeout(timer);
      pendingDelete.current = null;
      setToast(null);
      for (const ev of evs)
        deleteEvent(ev).catch((e) => {
          putEvent(null, ev);
          onError(e);
        });
    };
    const timer = setTimeout(commit, UNDO_MS);
    const cancel = () => {
      clearTimeout(timer);
      pendingDelete.current = null;
      for (const ev of evs) putEvent(null, ev);
      setToast(null);
    };
    pendingDelete.current = { timer, commit, cancel, evs };
    const deleted = evs;
    record({
      // Still in the undo window: nothing reached Google yet. Otherwise restore the deleted events.
      undo: async () => {
        if (pendingDelete.current?.evs === deleted) return pendingDelete.current.cancel();
        for (const ev of deleted) await restoreEvent(ev);
      },
      redo: () => remove(deleted.map(latest), "this"),
    });
    setToast({
      message: evs.length > 1 ? t("eventsDeleted", { n: evs.length }) : t("eventDeleted"),
      undo: cancel,
    });
  };
  useEffect(() => () => pendingDelete.current?.commit(), []);

  // --- Clipboard & context menu ---

  /** Ctrl+C copies (paste creates new events); Ctrl+X marks events so Ctrl+V moves them. */
  const [clip, setClip] = useState<{ mode: "copy" | "cut"; evs: CalEvent[] } | null>(null);
  const hoverTime = useRef<Date | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const flash = (message: string) => setToast({ message });
  useEffect(() => {
    if (!toast || toast.undo) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  /** A new event with the same content (no guests: pasting shouldn't send invitations). */
  const copyInput = (src: CalEvent, start: Date, end: Date): EventInput => {
    const visibility = src.event.visibility;
    return {
      summary: src.title,
      description: src.event.description,
      location: src.event.location,
      colorId: src.event.colorId,
      transparency: src.event.transparency,
      visibility: visibility === "public" || visibility === "private" ? visibility : undefined,
      ...eventTimes(start, end, src.allDay),
    };
  };

  /** Creates copies of `evs` shifted by `deltaMs`, then selects them. */
  const createCopies = async (evs: CalEvent[], deltaMs: number) => {
    try {
      const created = await Promise.all(
        evs.flatMap((src) => {
          const target = isWritable(src.calendar) ? src.calendar : defaultCalendar;
          if (!target) return [];
          const moved = shiftEvent(src, deltaMs);
          return [createEvent(target, copyInput(src, moved.start, moved.end))];
        }),
      );
      for (const ev of created) putEvent(null, ev);
      if (created.length) record(combine(created.map(createdEntry)));
      selectMany(created.map((ev) => ev.key));
    } catch (e) {
      onError(e);
    }
  };

  const copyEvents = (evs: CalEvent[]) => {
    setClip({ mode: "copy", evs });
    flash(evs.length > 1 ? t("eventsCopied", { n: evs.length }) : t("eventCopied"));
    // Also put readable lines on the system clipboard, handy for pasting into a message.
    const line = (ev: CalEvent) =>
      `${ev.title || t("untitled")} · ${ev.allDay ? f.fullDate(ev.start) : `${f.fullDate(ev.start)} ${f.time(ev.start)} – ${f.time(ev.end)}`}`;
    navigator.clipboard?.writeText(evs.map(line).join("\n")).catch(() => {});
  };

  const cutEvents = (evs: CalEvent[]) => {
    const editable = evs.filter(canEdit);
    if (!editable.length) return copyEvents(evs);
    setClip({ mode: "cut", evs: editable });
    flash(editable.length > 1 ? t("eventsCut", { n: editable.length }) : t("eventCut"));
  };

  /**
   * Paste so the earliest clipped event lands on `time` (the slot under the mouse) and the others
   * keep their offsets. Without a slot, paste at the original time.
   */
  const pasteAt = (time: Date | null) => {
    if (!clip) return;
    const anchor = new Date(Math.min(...clip.evs.map((e) => e.start.getTime())));
    const visible = anchor >= rangeStart && anchor < rangeEnd;
    const allDay = clip.evs.every((e) => e.allDay);
    const target = time
      ? allDay
        ? startOfDay(time)
        : time
      : visible
        ? anchor
        : atMinute(rangeStart, allDay ? 0 : minuteOfDay(anchor));
    const delta = target.getTime() - anchor.getTime();
    if (clip.mode === "cut") {
      setClip(null);
      shiftAll(clip.evs, delta);
      selectMany(clip.evs.map((e) => e.key));
    } else {
      void createCopies(clip.evs, delta);
    }
  };

  const duplicate = (evs: CalEvent[]) => void createCopies(evs, 0);

  const recolor = (evs: CalEvent[], colorId: string | null) => void updateMany(evs.filter(canEdit), () => ({ colorId }));

  /** Put private "busy" copies of the events on another of your calendars. */
  const blockOn = async (evs: CalEvent[], calendar: Calendar) => {
    try {
      const created = await Promise.all(
        evs.map((ev) =>
          createEvent(calendar, {
            summary: ev.title,
            ...eventTimes(ev.start, ev.end, ev.allDay),
            transparency: "opaque",
            visibility: "private",
          }),
        ),
      );
      for (const ev of created) putEvent(null, ev);
      if (created.length) record(combine(created.map(createdEntry)));
      flash(t("blockedOn", { name: calendarLabel(calendar) }));
    } catch (e) {
      onError(e);
    }
  };

  const newEventNow = () => {
    const today = startOfDay(new Date());
    const day = today >= rangeStart && today < rangeEnd ? today : rangeStart;
    const minute = day === today ? Math.ceil((minuteOfDay(new Date()) + 1) / 30) * 30 : 9 * 60;
    const start = atMinute(day, Math.min(minute, 23 * 60 + 30));
    startDraft(start, addMinutes(start, settings.defaultDuration), false);
  };

  // --- Navigation ---

  const go = useCallback((dir: 1 | -1) => setRangeStart((s) => addDays(s, dir * days)), [days]);
  const shiftDays = useCallback((n: number) => setRangeStart((s) => addDays(s, n)), []);
  const goToday = useCallback(() => setRangeStart(alignStart(new Date())), [alignStart]);

  const toggleScheduling = () => {
    setScheduling((s) => !s);
    select(null);
  };

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      e.stopPropagation();
      toggleSidebar();
      return;
    }
    const inField = e.target instanceof HTMLElement && !!e.target.closest("input, textarea, select, [contenteditable]");
    // Ctrl+C / X / V / D on events. Text fields and selected text keep their normal behaviour.
    if (scopeAsk || searchOpen) return; // Those dialogs handle their own keys.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setSearchOpen(true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === ",") {
      e.preventDefault();
      setSettingsOpen(true);
      return;
    }
    // Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo. In text fields they keep undoing typing.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !inField && !settingsOpen && ["z", "y"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      void replay(e.key.toLowerCase() === "y" || e.shiftKey ? "redo" : "undo");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !inField && !settingsOpen && !window.getSelection()?.toString()) {
      const k = e.key.toLowerCase();
      // The selection, or else the event under the mouse.
      const hoveredKey = document.querySelector(".week [data-event-key]:hover")?.getAttribute("data-event-key");
      const hovered = hoveredKey ? visibleEvents.find((ev) => ev.key === hoveredKey) : undefined;
      const selection = selectedEvents.filter((e) => e.key !== "draft");
      const targets = selection.length ? selection : hovered ? [hovered] : [];
      let handled = true;
      if (k === "c" && targets.length) copyEvents(targets);
      else if (k === "x" && targets.length) cutEvents(targets);
      else if (k === "v" && clip) pasteAt(hoverTime.current);
      else if (k === "d" && targets.length) duplicate(targets);
      else handled = false;
      if (handled) {
        e.preventDefault();
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || e.altKey || settingsOpen) return;
    // Open pickers and menus close themselves on Esc; don't also clear the selection.
    if (e.key === "Escape" && document.querySelector(".picker, .context-menu")) return;
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]")) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    const key = e.key.toLowerCase();
    if (key === "escape") {
      if (clip?.mode === "cut") setClip(null);
      else if (selectedKeys.size) select(null);
      else if (scheduling) setScheduling(false);
    } else if (key === "t") goToday();
    else if (key === "j" || key === "n" || key === "arrowright") go(1);
    else if (key === "k" || key === "p" || key === "arrowleft") go(-1);
    else if (key === "d") setDays(1);
    else if (key === "w") setDays(7);
    else if (/^[1-9]$/.test(key)) setDays(Math.min(maxDays, Number(key)));
    else if (key === "0") setDays(Math.min(maxDays, 10));
    else if (key === "c") newEventNow();
    else if (key === "\\") toggleSidebar();
    else if (key === ".") togglePanel();
    else if (key === "h") update({ privacy: !settings.privacy });
    else if (key === "/") setSearchOpen(true);
    else if (key === "delete" && selectedEvents.length) remove(selectedEvents);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    // Capture phase, so Ctrl+B is handled before anything else can react to it.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const account = calendars.find((c) => c.primary)?.id;
  // On narrow windows the panel overlays the grid, so only open it on demand.
  // Several selected events show the selection bar instead of their details.
  const inPopover = !!selectedEvent && !multi && !scheduling && settings.eventDetails === "popover";
  const panelVisible = (settings.panel && wide) || (!!selectedEvent && !multi && !inPopover) || scheduling;
  const closeDetails = useCallback(() => {
    setDraft(null);
    setSelectedKey(null);
    setExtraKeys([]);
  }, []);
  const togglePanel = () => {
    if (panelVisible) {
      select(null);
      setScheduling(false);
    }
    update({ panel: !panelVisible });
  };

  return (
    <div className="app">
      {mobile && drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      {(mobile ? drawerOpen : settings.sidebar) && (
        <Sidebar
          onClose={() => (mobile ? setDrawerOpen(false) : update({ sidebar: false }))}
          onReorder={(ids) => update({ calendarOrder: ids })}
          calendars={orderedCalendars}
          hidden={hidden}
          onToggle={toggleCalendar}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          today={now}
          onPickDate={(d) => fromDrawer(() => setRangeStart(alignStart(d)))()}
          onNewEvent={fromDrawer(newEventNow)}
          onSearch={fromDrawer(() => setSearchOpen(true))}
          scheduling={scheduling}
          onSchedule={fromDrawer(toggleScheduling)}
        />
      )}
      <main className="main">
        <Toolbar
          title={f.rangeTitle(rangeStart, rangeEnd, mobile)}
          showSidebarToggle={mobile || !settings.sidebar}
          onToggleSidebar={toggleSidebar}
          days={days}
          maxDays={maxDays}
          onDays={setDays}
          loading={pending > 0}
          account={account}
          panelVisible={panelVisible}
          onToday={goToday}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onTogglePanel={togglePanel}
          onOpenSettings={() => setSettingsOpen(true)}
          onSignOut={onSignOut}
        />
        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="link-button" onClick={onDismissError}>
              {t("dismiss")}
            </button>
          </div>
        )}
        <WeekView
          days={dayList}
          events={visibleEvents}
          now={now}
          selectedKeys={selectedKeys}
          scheduling={scheduling}
          slots={slots}
          onSelect={select}
          onCreate={startDraft}
          onMove={moveTo}
          onDragPreview={setDragPreview}
          onMoveMany={shiftAll}
          onAddSlot={(slot) => setSlots((s) => [...s, slot].sort((a, b) => a.start.getTime() - b.start.getTime()))}
          onRemoveSlot={(i) => setSlots((s) => s.filter((_, j) => j !== i))}
          onShiftDays={shiftDays}
          focus={focus}
          onContextMenu={setMenu}
          onHoverTime={(time) => (hoverTime.current = time)}
          cutKeys={new Set(clip?.mode === "cut" ? clip.evs.map((e) => e.key) : [])}
        />
      </main>
      {panelVisible && (
        <aside className="panel">
          {scheduling ? (
            <SchedulePanel
              slots={slots}
              calendars={orderedCalendars}
              hidden={hidden}
              onRemoveSlot={(i) => setSlots((s) => s.filter((_, j) => j !== i))}
              onClearSlots={() => setSlots([])}
              onClose={() => setScheduling(false)}
              onError={onError}
            />
          ) : selectedEvent && !multi && !inPopover ? (
            <EventPanel
              key={`${selectedEvent.key}:${detailsRevision}`}
              variant="panel"
              onToggleVariant={() => update({ eventDetails: "popover" })}
              ev={shownEvent!}
              knownEvents={knownEvents}
              isDraft={selectedEvent.key === "draft"}
              calendars={orderedCalendars}
              onCreate={saveDraft}
              onUpdate={applyUpdate}
              onMoveCalendar={changeCalendar}
              onDelete={remove}
              onDraftChange={setDraft}
              onClose={() => select(null)}
            />
          ) : (
            <Shortcuts onClose={() => update({ panel: false })} />
          )}
        </aside>
      )}
      {inPopover && selectedEvent && (
        <EventPopover eventKey={selectedEvent.key} onClose={closeDetails}>
          <EventPanel
            key={`${selectedEvent.key}:${detailsRevision}`}
            variant="popover"
            onToggleVariant={() => update({ eventDetails: "panel" })}
            ev={shownEvent!}
            knownEvents={knownEvents}
            isDraft={selectedEvent.key === "draft"}
            calendars={orderedCalendars}
            onCreate={saveDraft}
            onUpdate={applyUpdate}
            onMoveCalendar={changeCalendar}
            onDelete={remove}
            onDraftChange={setDraft}
            onClose={closeDetails}
          />
        </EventPopover>
      )}
      {menu && (
        <ContextMenu
          target={menu}
          onClose={closeMenu}
          canPaste={!!clip}
          calendars={orderedCalendars}
          group={menu.kind === "event" ? groupFor(menu.ev) : []}
          onColor={recolor}
          onBlockOn={blockOn}
          onCut={cutEvents}
          onCopy={copyEvents}
          onDuplicate={duplicate}
          onDelete={remove}
          onPaste={pasteAt}
          onNewEvent={(time) => startDraft(time, addMinutes(time, settings.defaultDuration), false)}
        />
      )}
      {multi && (
        <SelectionBar
          count={selectedEvents.length}
          onCopy={() => copyEvents(selectedEvents)}
          onCut={() => cutEvents(selectedEvents)}
          onDuplicate={() => duplicate(selectedEvents)}
          onDelete={() => remove(selectedEvents)}
          onClear={() => select(null)}
        />
      )}
      {searchOpen && (
        <SearchDialog
          calendars={orderedCalendars.filter((c) => !hidden.has(c.id))}
          knownEvents={knownEvents.filter((e) => !hidden.has(e.calendar.id))}
          onPick={openFromSearch}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {scopeAsk && (
        <RecurrenceDialog
          kind={scopeAsk.kind}
          onDone={(scope) => {
            scopeAsk.resolve(scope);
            setScopeAsk(null);
          }}
        />
      )}
      {settingsOpen && <SettingsDialog calendars={orderedCalendars} onClose={() => setSettingsOpen(false)} />}
      {toast && (
        <div className="toast">
          <span>{toast.message}</span>
          {toast.undo && (
            <button className="link-button" onClick={toast.undo}>
              {t("undo")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
