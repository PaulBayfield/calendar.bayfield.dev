import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { canEdit, type CalEvent } from "../lib/google";
import type { Slot } from "../lib/server";
import { addMinutes, atMinute, dayDiff, isSameDay, isWeekend, minuteOfDay } from "../lib/dates";
import { utcOffsetLabel } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import type { MenuTarget } from "./ContextMenu";
import { Lock } from "./icons";

export const HOUR_HEIGHT = 60;
const ALLDAY_LANE_HEIGHT = 24;
/** One snap step (15 min), so back-to-back short events tile instead of overlapping. */
const MIN_EVENT_HEIGHT = 15;
const SNAP = 15;
const DRAG_THRESHOLD = 4;
/** Horizontal scroll distance (px) that moves the view by one day. */
const SCROLL_PER_DAY = 100;
/** Touch: hold this long to start dragging instead of scrolling. */
const LONG_PRESS_MS = 450;
const TOUCH_SLOP = 10;
const SWIPE_PX = 60;

interface Props {
  days: Date[];
  events: CalEvent[];
  now: Date;
  /** Selected events (several with Ctrl/Shift+click). */
  selectedKeys: Set<string>;
  scheduling: boolean;
  slots: Slot[];
  /** `additive`: Ctrl/Shift+click, toggles the event in the selection. */
  onSelect: (event: CalEvent | null, additive?: boolean) => void;
  /** Several selected events dragged together by `deltaMs`. */
  onMoveMany: (events: CalEvent[], deltaMs: number) => void;
  onCreate: (start: Date, end: Date, allDay: boolean) => void;
  onMove: (event: CalEvent, start: Date, end: Date) => void;
  onAddSlot: (slot: Slot) => void;
  onRemoveSlot: (index: number) => void;
  onShiftDays: (n: number) => void;
  onContextMenu: (target: MenuTarget) => void;
  /** Slot under the mouse (for Ctrl+V), or null when it leaves the grid. */
  onHoverTime: (time: Date | null) => void;
  /** Event waiting to be moved by Ctrl+X → Ctrl+V. */
  cutKeys: Set<string>;
  /** Scroll so this time is in view (e.g. an event picked from search); `seq` re-triggers it. */
  focus?: { time: Date; seq: number };
}

type Drag =
  /** `anchor`: start of the slot pressed. `floor`/`ceil`: edges of the slot under the pointer now. */
  | { kind: "create"; anchor: Date; floor: Date; ceil: Date; moved: boolean; x: number; y: number; hadSelection: boolean }
  | { kind: "move"; ev: CalEvent; group: CalEvent[]; offsetMs: number; start: Date; end: Date; moved: boolean; x: number; y: number; additive: boolean }
  /** Dragging the top (`start`) or bottom (`end`) edge of an event. */
  | { kind: "resize"; edge: "start" | "end"; ev: CalEvent; start: Date; end: Date; moved: boolean; x: number; y: number; additive: boolean }
  /** A finger is down but we don't know yet: tap, swipe, scroll, or long press. */
  | { kind: "touch"; ev?: CalEvent; anchor: Date; moved: boolean; x: number; y: number; hadSelection: boolean };

export function WeekView(props: Props) {
  const { days, events, now, selectedKeys, scheduling, slots } = props;
  const { t, f, settings } = useSettings();
  const weekRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  // Handlers read the gesture from this ref: a quick tap's pointerup can arrive before React
  // has re-rendered with the state set on pointerdown.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Touch long-presses also fire contextmenu; only mouse/pen right-clicks open the menu. */
  const lastPointerType = useRef("mouse");

  type Spot = { kind: "event"; ev: CalEvent } | { kind: "slot"; time: Date };
  const openMenu = (e: React.MouseEvent, spot: Spot) => {
    e.preventDefault();
    e.stopPropagation();
    if (lastPointerType.current === "touch" || scheduling) return;
    propsRef.current.onContextMenu({ ...spot, x: e.clientX, y: e.clientY });
  };

  // Once a long press has turned into a drag, keep the grid from scrolling under the finger.
  useEffect(() => {
    const el = columnsRef.current!;
    const onTouchMove = (e: TouchEvent) => {
      const d = dragRef.current;
      if (d && d.kind !== "touch" && e.cancelable) e.preventDefault();
    };
    const onContextMenu = (e: Event) => e.preventDefault(); // Long press shouldn't open a menu.
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("contextmenu", onContextMenu);
    return () => {
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("contextmenu", onContextMenu);
      clearTimeout(pressTimer.current);
    };
  }, []);

  useEffect(() => {
    // Land just above an hour line so its label isn't cut in half.
    scrollRef.current?.scrollTo({ top: Math.max(0, (now.getHours() - 3) * HOUR_HEIGHT - 12) });
    // Only on mount: don't yank the scroll position while the user is looking around.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!props.focus) return;
    const el = scrollRef.current!;
    const top = (minuteOfDay(props.focus.time) / 60) * HOUR_HEIGHT;
    // Leave some context above the event.
    el.scrollTo({ top: Math.max(0, top - HOUR_HEIGHT * 1.5), behavior: "smooth" });
  }, [props.focus]);

  // Shift + wheel (or a horizontal trackpad swipe) moves the view day by day.
  useEffect(() => {
    const el = weekRef.current!;
    let acc = 0;
    let idle: ReturnType<typeof setTimeout>;
    const onWheel = (e: WheelEvent) => {
      const dx = e.shiftKey ? e.deltaX || e.deltaY : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
      if (!dx) return;
      e.preventDefault();
      acc += e.deltaMode === 1 ? dx * 40 : dx;
      const n = Math.trunc(acc / SCROLL_PER_DAY);
      if (n) {
        acc -= n * SCROLL_PER_DAY;
        propsRef.current.onShiftDays(n);
      }
      clearTimeout(idle);
      idle = setTimeout(() => (acc = 0), 250);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** Pointer position → day index and (unsnapped) minute of day. */
  const pointAt = (clientX: number, clientY: number) => {
    const rect = columnsRef.current!.getBoundingClientRect();
    const day = Math.min(days.length - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * days.length)));
    const minute = Math.min(24 * 60, Math.max(0, ((clientY - rect.top) / HOUR_HEIGHT) * 60));
    return { day, minute };
  };
  const snap = (m: number) => Math.round(m / SNAP) * SNAP;
  const timeAt = (clientX: number, clientY: number, mode: "round" | "floor" = "round") => {
    const { day, minute } = pointAt(clientX, clientY);
    return atMinute(days[day], mode === "floor" ? Math.floor(minute / SNAP) * SNAP : snap(minute));
  };

  const capture = (e: React.PointerEvent) => columnsRef.current!.setPointerCapture(e.pointerId);

  /** Touch starts undecided; a still finger becomes a drag after LONG_PRESS_MS. */
  const startTouch = (e: React.PointerEvent, ev?: CalEvent) => {
    const anchor = timeAt(e.clientX, e.clientY, "floor");
    const point = pointAt(e.clientX, e.clientY);
    const x = e.clientX;
    const y = e.clientY;
    setDrag({ kind: "touch", ev, anchor, moved: false, x, y, hadSelection: selectedKeys.size > 0 && !scheduling });
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      const d = dragRef.current;
      if (d?.kind !== "touch" || d.moved) return;
      if (ev) {
        if (!canEdit(ev) || ev.allDay || scheduling) return;
        navigator.vibrate?.(10);
        const offsetMs = atMinute(days[point.day], point.minute).getTime() - ev.start.getTime();
        setDrag({ kind: "move", ev, group: [ev], offsetMs, start: ev.start, end: ev.end, moved: false, x, y, additive: false });
      } else {
        navigator.vibrate?.(10);
        setDrag({ kind: "create", anchor, floor: anchor, ceil: addMinutes(anchor, settings.defaultDuration), moved: true, x, y, hadSelection: false });
      }
    }, LONG_PRESS_MS);
  };

  const onGridPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return startTouch(e);
    if (e.button !== 0) return;
    capture(e);
    const anchor = timeAt(e.clientX, e.clientY, "floor");
    setDrag({
      kind: "create",
      anchor,
      floor: anchor,
      ceil: addMinutes(anchor, SNAP),
      moved: false,
      x: e.clientX,
      y: e.clientY,
      hadSelection: selectedKeys.size > 0 && !scheduling,
    });
  };

  const onEventPointerDown = (ev: CalEvent, e: React.PointerEvent) => {
    e.stopPropagation();
    const handle = (e.target as HTMLElement).closest<HTMLElement>(".resize-handle");
    if (e.pointerType === "touch" && !(handle && selectedKeys.has(ev.key))) return startTouch(e, scheduling ? undefined : ev);
    if (e.button !== 0 || scheduling) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!canEdit(ev) || ev.allDay) {
      props.onSelect(ev, additive);
      return;
    }
    capture(e);
    const { day, minute } = pointAt(e.clientX, e.clientY);
    const base = { ev, start: ev.start, end: ev.end, moved: false, x: e.clientX, y: e.clientY, additive };
    // Dragging one of several selected events moves them all.
    const group =
      selectedKeys.has(ev.key) && selectedKeys.size > 1
        ? events.filter((x) => selectedKeys.has(x.key) && x.key !== "draft" && canEdit(x))
        : [ev];
    setDrag(
      handle
        ? { kind: "resize", edge: handle.dataset.edge === "start" ? "start" : "end", ...base }
        : { kind: "move", ...base, group, offsetMs: atMinute(days[day], minute).getTime() - ev.start.getTime() },
    );
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") propsRef.current.onHoverTime(timeAt(e.clientX, e.clientY, "floor"));
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "touch") {
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > TOUCH_SLOP) setDrag({ ...drag, moved: true });
      return;
    }
    const moved = drag.moved || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > DRAG_THRESHOLD;
    if (drag.kind === "create") {
      const { day, minute } = pointAt(e.clientX, e.clientY);
      setDrag({
        ...drag,
        moved,
        floor: atMinute(days[day], Math.floor(minute / SNAP) * SNAP),
        ceil: atMinute(days[day], Math.ceil(minute / SNAP) * SNAP),
      });
    } else if (drag.kind === "move") {
      const { day, minute } = pointAt(e.clientX, e.clientY);
      // Offset from where the event was grabbed, in absolute time, so multi-day events can
      // be grabbed on any of their days and spill over midnight freely.
      const duration = (drag.ev.end.getTime() - drag.ev.start.getTime()) / 60_000;
      const raw = new Date(atMinute(days[day], minute).getTime() - drag.offsetMs);
      const start = atMinute(raw, snap(minuteOfDay(raw) + raw.getSeconds() / 60));
      setDrag({ ...drag, moved, start, end: addMinutes(start, duration) });
    } else if (drag.edge === "start") {
      // Keep at least one snap step of event.
      const start = timeAt(e.clientX, e.clientY);
      setDrag({ ...drag, moved, start: start < drag.end ? start : addMinutes(drag.end, -SNAP) });
    } else {
      const end = timeAt(e.clientX, e.clientY);
      setDrag({ ...drag, moved, end: end > drag.start ? end : addMinutes(drag.start, SNAP) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    clearTimeout(pressTimer.current);
    const drag = dragRef.current;
    if (!drag) return;
    setDrag(null);
    const p = propsRef.current;
    if (drag.kind === "touch") {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      // Horizontal swipe: next/previous page of days.
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) return p.onShiftDays(dx < 0 ? days.length : -days.length);
      if (drag.moved) return;
      if (drag.ev) return p.onSelect(drag.ev);
      if (drag.hadSelection) return p.onSelect(null);
      const end = addMinutes(drag.anchor, settings.defaultDuration);
      if (scheduling) p.onAddSlot({ start: drag.anchor, end });
      else p.onCreate(drag.anchor, end, false);
      return;
    }
    if (drag.kind === "create") {
      if (!drag.moved && drag.hadSelection) return p.onSelect(null);
      const range = drag.moved ? createRange(drag) : { start: drag.anchor, end: addMinutes(drag.anchor, settings.defaultDuration) };
      if (scheduling) p.onAddSlot(range);
      else p.onCreate(range.start, range.end, false);
    } else if (!drag.moved) {
      p.onSelect(drag.ev, drag.additive);
    } else if (drag.start.getTime() !== drag.ev.start.getTime() || drag.end.getTime() !== drag.ev.end.getTime()) {
      if (drag.kind === "move" && drag.group.length > 1) p.onMoveMany(drag.group, drag.start.getTime() - drag.ev.start.getTime());
      else p.onMove(drag.ev, drag.start, drag.end);
    }
  };

  // Show the dragged event at its preview position.
  const shown = useMemo(() => {
    if (!drag || drag.kind === "create" || drag.kind === "touch") return events;
    if (drag.kind === "move" && drag.group.length > 1) {
      const moved = new Map(drag.group.map((g) => [g.key, shiftEvent(g, drag.start.getTime() - drag.ev.start.getTime())]));
      return events.map((e) => moved.get(e.key) ?? e);
    }
    return events.map((e) => (e.key === drag.ev.key ? { ...e, start: drag.start, end: drag.end } : e));
  }, [events, drag]);
  const ghost = drag?.kind === "create" && drag.moved ? createRange(drag) : null;

  // The drag preview may span several days: draw the slice that falls on each one.
  const ghostSegment = (day: Date) => {
    const seg = ghost && daySegment(ghost.start, ghost.end, day);
    if (!ghost || !seg) return null;
    return (
      <div
        className={scheduling ? "slot ghost" : "event draft ghost"}
        style={{ "--c": "var(--primary)", ...seg, left: 1, width: "calc(100% - 4px)" } as CSSProperties}
      >
        {isSameDay(ghost.start, day) && (
          <span className="event-time">
            {f.time(ghost.start)} – {f.time(ghost.end)}
          </span>
        )}
      </div>
    );
  };

  const allDay = useMemo(() => layoutAllDay(days, shown), [days, shown]);
  const timed = useMemo(() => days.map((day) => layoutDay(day, shown)), [days, shown]);
  const nowTop = (minuteOfDay(now) / 60) * HOUR_HEIGHT;
  const columns = { "--days": days.length, "--hour": `${HOUR_HEIGHT}px` } as CSSProperties;

  const eventClass = (ev: CalEvent, ...extra: (string | false)[]) =>
    [
      "event",
      ev.declined && "declined",
      ev.end < now && "past",
      selectedKeys.has(ev.key) && "selected",
      ev.key === "draft" && "draft",
      props.cutKeys.has(ev.key) && "cut",
      (drag?.kind === "move" || drag?.kind === "resize") &&
        (drag.ev.key === ev.key || (drag.kind === "move" && drag.moved && drag.group.some((g) => g.key === ev.key))) &&
        "dragging",
      ...extra,
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <div
      className={`week${scheduling ? " scheduling" : ""}`}
      style={columns}
      ref={weekRef}
      onPointerDownCapture={(e) => (lastPointerType.current = e.pointerType)}
    >
      <div className="week-head">
        <div className="gutter tz-label">{utcOffsetLabel(now)}</div>
        <div className="day-heads">
          {days.map((day) => (
            <div key={day.toISOString()} className={`day-head${isSameDay(day, now) ? " today" : ""}`}>
              <span className="weekday">{f.weekday(day)}</span>
              <span className="date">{day.getDate()}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="allday">
        <div className="gutter allday-label">{t("allDay")}</div>
        <div className="allday-lanes" style={{ height: Math.max(1, allDay.lanes) * ALLDAY_LANE_HEIGHT + 6 }}>
          {days.map((day, i) => (
            <div
              key={i}
              className={`allday-cell${isWeekend(day) ? " weekend" : ""}`}
              style={{ gridColumn: i + 1 }}
              onClick={() => !scheduling && props.onCreate(day, atMinute(day, 24 * 60), true)}
            />
          ))}
          {allDay.items.map(({ ev, from, to, lane }) => (
            <button
              key={ev.key}
              data-event-key={ev.key}
              className={eventClass(ev)}
              style={
                {
                  "--c": ev.color,
                  left: `calc(${(from / days.length) * 100}% + 2px)`,
                  width: `calc(${((to - from + 1) / days.length) * 100}% - 4px)`,
                  top: lane * ALLDAY_LANE_HEIGHT + 3,
                  height: ALLDAY_LANE_HEIGHT - 3,
                } as CSSProperties
              }
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => !scheduling && props.onSelect(ev, e.ctrlKey || e.metaKey || e.shiftKey)}
              onContextMenu={(e) => openMenu(e, { kind: "event", ev })}
            >
              <span className="event-title">{ev.title || t("untitled")}</span>
              {!canEdit(ev) && <ReadOnlyMark />}
            </button>
          ))}
        </div>
      </div>

      <div className="grid-scroll" ref={scrollRef}>
        <div className="grid" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className="gutter hours">
            {Array.from({ length: 23 }, (_, i) => i + 1)
              // Give way to the current-time badge when it sits on top of an hour label.
              .filter((h) => Math.abs(minuteOfDay(now) - h * 60) >= 15)
              .map((h) => (
                <span key={h} className="hour-label" style={{ top: h * HOUR_HEIGHT }}>
                  {f.hourLabel(h)}
                </span>
              ))}
            <span className="now-badge" style={{ top: nowTop }}>
              {f.time(now)}
            </span>
          </div>
          <div
            className="columns"
            ref={columnsRef}
            onPointerDown={onGridPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => propsRef.current.onHoverTime(null)}
            onContextMenu={(e) => openMenu(e, { kind: "slot", time: timeAt(e.clientX, e.clientY, "floor") })}
            onPointerCancel={() => {
              // The browser took over (native scroll): forget the gesture.
              clearTimeout(pressTimer.current);
              setDrag(null);
            }}
          >
            <div className="now-rule" style={{ top: nowTop }} />
            {days.map((day, i) => (
              <div key={day.toISOString()} className={`column${isWeekend(day) ? " weekend" : ""}`}>
                {timed[i].map(({ ev, startMin, endMin, col, cols }) => {
                  const height = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, MIN_EVENT_HEIGHT);
                  const editable = canEdit(ev) && !scheduling;
                  return (
                    <div
                      key={ev.key}
                      role="button"
                      tabIndex={0}
                      data-event-key={ev.key}
                      className={eventClass(ev, height < 40 && "compact", height < 24 && "tiny")}
                      style={
                        {
                          "--c": ev.color,
                          // Exactly on the time lines, with a 1px gap below to separate back-to-back events.
                          top: (startMin / 60) * HOUR_HEIGHT,
                          height: height - 1,
                          left: `calc(${(col / cols) * 100}% + 1px)`,
                          width: `calc(${100 / cols}% - 4px)`,
                        } as CSSProperties
                      }
                      onPointerDown={(e) => onEventPointerDown(ev, e)}
                      onContextMenu={(e) => openMenu(e, { kind: "event", ev })}
                      onKeyDown={(e) => e.key === "Enter" && props.onSelect(ev)}
                    >
                      <span className="event-title">{ev.title || t("untitled")}</span>
                      <span className="event-time">
                        {f.time(ev.start)}
                        {height >= 56 && ` – ${f.time(ev.end)}`}
                      </span>
                      {editable && ev.start.getTime() >= day.getTime() && (
                        <span className="resize-handle top" data-edge="start" />
                      )}
                      {editable && ev.end.getTime() <= atMinute(day, 24 * 60).getTime() && (
                        <span className="resize-handle bottom" data-edge="end" />
                      )}
                      {!canEdit(ev) && <ReadOnlyMark />}
                    </div>
                  );
                })}
                {slots.map((slot, si) => {
                  const seg = daySegment(slot.start, slot.end, day);
                  return seg ? (
                    <button
                      key={`slot-${si}`}
                      className="slot"
                      style={seg}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => props.onRemoveSlot(si)}
                    >
                      {f.time(slot.start)} – {f.time(slot.end)}
                    </button>
                  ) : null;
                })}
                {ghostSegment(day)}
                {isSameDay(day, now) && <div className="now-line" style={{ top: nowTop }} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReadOnlyMark() {
  const { t } = useSettings();
  return (
    <span className="event-lock" title={t("readOnly")}>
      <Lock size={10} />
    </span>
  );
}

/** Moves an event by `deltaMs`; all-day events move by whole days. */
export function shiftEvent(ev: CalEvent, deltaMs: number): CalEvent {
  if (ev.allDay) {
    const days = Math.round(deltaMs / 86_400_000);
    const start = new Date(ev.start);
    start.setDate(start.getDate() + days);
    const end = new Date(ev.end);
    end.setDate(end.getDate() + days);
    return { ...ev, start, end };
  }
  return { ...ev, start: new Date(ev.start.getTime() + deltaMs), end: new Date(ev.end.getTime() + deltaMs) };
}

/**
 * What a create-drag covers: every 15-minute slot from the one pressed to the one under the
 * pointer, both included, whichever direction the drag goes.
 */
function createRange(drag: { anchor: Date; floor: Date; ceil: Date }): { start: Date; end: Date } {
  const anchorEnd = addMinutes(drag.anchor, SNAP);
  return drag.floor < drag.anchor
    ? { start: drag.floor, end: anchorEnd }
    : { start: drag.anchor, end: drag.ceil > anchorEnd ? drag.ceil : anchorEnd };
}

/** Position of the part of [start, end) that falls on `day`, or null if none does. */
function daySegment(start: Date, end: Date, day: Date): { top: number; height: number } | null {
  const dayStart = day.getTime();
  const dayEnd = atMinute(day, 24 * 60).getTime();
  const from = Math.max(start.getTime(), dayStart);
  const to = Math.min(Math.max(end.getTime(), start.getTime() + SNAP * 60_000), dayEnd);
  if (to <= from) return null;
  return {
    top: ((from - dayStart) / 3_600_000) * HOUR_HEIGHT,
    height: ((to - from) / 3_600_000) * HOUR_HEIGHT,
  };
}

interface TimedSegment {
  ev: CalEvent;
  startMin: number;
  endMin: number;
  col: number;
  cols: number;
}

/** Places a day's timed events into side-by-side columns where they overlap. */
function layoutDay(day: Date, events: CalEvent[]): TimedSegment[] {
  const dayStart = day.getTime();
  const dayEnd = atMinute(day, 24 * 60).getTime();
  const segments: TimedSegment[] = events
    .filter((ev) => !ev.allDay && ev.start.getTime() < dayEnd && ev.end.getTime() > dayStart)
    .map((ev) => ({
      ev,
      startMin: Math.max(0, (ev.start.getTime() - dayStart) / 60000),
      endMin: Math.min(24 * 60, (ev.end.getTime() - dayStart) / 60000),
      col: 0,
      cols: 1,
    }))
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // A cluster is a run of transitively overlapping events; they all share one column count.
  const minVisualMinutes = (MIN_EVENT_HEIGHT / HOUR_HEIGHT) * 60;
  let cluster: TimedSegment[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;
  const closeCluster = () => {
    for (const s of cluster) s.cols = columnEnds.length;
    cluster = [];
    columnEnds = [];
  };

  for (const seg of segments) {
    if (seg.startMin >= clusterEnd) closeCluster();
    const visualEnd = Math.max(seg.endMin, seg.startMin + minVisualMinutes);
    let col = columnEnds.findIndex((end) => end <= seg.startMin);
    if (col === -1) col = columnEnds.push(0) - 1;
    columnEnds[col] = visualEnd;
    seg.col = col;
    cluster.push(seg);
    clusterEnd = Math.max(clusterEnd, visualEnd);
  }
  closeCluster();
  return segments;
}

interface AllDayItem {
  ev: CalEvent;
  from: number;
  to: number;
  lane: number;
}

/** Stacks all-day events (which may span several days) into lanes. */
function layoutAllDay(days: Date[], events: CalEvent[]): { items: AllDayItem[]; lanes: number } {
  const first = days[0];
  const last = days.length - 1;
  const items = events
    .filter((ev) => ev.allDay)
    .map((ev) => ({
      ev,
      from: Math.max(0, dayDiff(first, ev.start)),
      to: Math.min(last, dayDiff(first, ev.end) - 1),
      lane: 0,
    }))
    .filter((item) => item.from <= last && item.to >= 0 && item.to >= item.from)
    .sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from));

  const laneEnds: number[] = [];
  for (const item of items) {
    let lane = laneEnds.findIndex((end) => end < item.from);
    if (lane === -1) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = item.to;
    item.lane = lane;
  }
  return { items, lanes: laneEnds.length };
}
