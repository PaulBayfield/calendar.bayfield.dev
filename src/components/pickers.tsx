// Custom date and time pickers (replacing the browser's native ones).
// Their dropdowns are portalled to <body> so the popover's overflow can't clip them.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { addDays, addMonths, atMinute, isSameDay, parseDateOnly, startOfWeek, toDateOnly } from "../lib/dates";
import { useSettings } from "../lib/settings";
import { useMediaQuery } from "../lib/useMediaQuery";
import { ChevronLeft, ChevronRight } from "./icons";

const GAP = 4;
const MARGIN = 8;

/** Floating layer under (or above) `anchor`; closes on outside click and Esc. */
export function Dropdown({ anchor, onClose, children, className = "" }: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const el = ref.current;
    if (!a || !el) return;
    const below = a.bottom + GAP + el.offsetHeight <= window.innerHeight - MARGIN;
    setPos({
      left: Math.min(Math.max(MARGIN, a.left), window.innerWidth - el.offsetWidth - MARGIN),
      top: below ? a.bottom + GAP : Math.max(MARGIN, a.top - GAP - el.offsetHeight),
    });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onScroll = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`picker ${className}`}
      style={pos ?? { left: -9999, top: 0, visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}

// --- Date ---

interface DatePickerProps {
  /** "YYYY-MM-DD" */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function DatePicker({ value, onChange, disabled }: DatePickerProps) {
  const { f } = useSettings();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const date = parseDateOnly(value);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`field-button${open ? " open" : ""}`}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {f.shortDate(date)}
      </button>
      {open && (
        <Dropdown anchor={anchor} onClose={() => setOpen(false)}>
          <MonthGrid
            selected={date}
            onPick={(d) => {
              onChange(toDateOnly(d));
              setOpen(false);
            }}
          />
        </Dropdown>
      )}
    </>
  );
}

function MonthGrid({ selected, onPick }: { selected: Date; onPick: (d: Date) => void }) {
  const { f, settings } = useSettings();
  const [month, setMonth] = useState(() => addMonths(selected, 0));
  const today = new Date();
  const gridStart = startOfWeek(month, settings.weekStartsOn);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  return (
    <div className="picker-month">
      <div className="mini-month-head">
        <span className="mini-month-title">{f.monthYear(month)}</span>
        <button type="button" className="icon-button small" onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft />
        </button>
        <button type="button" className="icon-button small" onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRight />
        </button>
      </div>
      <div className="mini-month-row">
        {cells.slice(0, 7).map((d) => (
          <span key={d.getDay()} className="mini-weekday">
            {f.weekdayMini(d)}
          </span>
        ))}
      </div>
      <div className="picker-days">
        {cells.map((d) => {
          const classes = [
            "mini-day",
            d.getMonth() !== month.getMonth() && "outside",
            isSameDay(d, today) && "today",
            isSameDay(d, selected) && "selected",
          ];
          return (
            <button type="button" key={d.toISOString()} className={classes.filter(Boolean).join(" ")} onClick={() => onPick(d)}>
              <span>{d.getDate()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Time ---

/** Accepts "14:30", "14h30", "1430", "14", "2pm", "2:30 pm". Returns "HH:MM" or null. */
export function parseTime(input: string): string | null {
  const m = input.trim().toLowerCase().match(/^(\d{1,2})(?:\s*[:h.]?\s*(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]?.startsWith("p") && h < 12) h += 12;
  if (m[3]?.startsWith("a") && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const days = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [days && `${days} j`, h && `${h} h`, m && `${m}`].filter(Boolean).join(" ");
}

interface TimePickerProps {
  /** "HH:MM" */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** For an end time on the same day: only list later times, labelled with their duration. */
  after?: string;
  /** Apply a typed time after a short pause, without waiting for Enter (default true). */
  live?: boolean;
}

/** Pause after typing before a typed time is applied. */
const LIVE_DELAY_MS = 500;

export function TimePicker({ value, onChange, disabled, after, live = true }: TimePickerProps) {
  const { f } = useSettings();
  const anchor = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const label = (hhmm: string) => f.time(atMinute(new Date(), toMinutes(hhmm)));
  const [text, setText] = useState(label(value));
  // On touch screens, pick from the list instead of popping up the keyboard.
  const touch = useMediaQuery("(pointer: coarse)");

  const focused = useRef(false);
  const liveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Follow outside changes, but never rewrite what the user is in the middle of typing.
  useEffect(() => {
    if (!focused.current) setText(label(value));
  }, [value, f]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(liveTimer.current), []);

  const from = after ? toMinutes(after) + 15 : 0;
  const options = Array.from({ length: 96 }, (_, i) => i * 15).filter((m) => m >= from);
  // While typing, the list follows the typed time ("18" highlights 18:00).
  const typed = parseTime(text);
  const current = toMinutes(typed ?? value);
  const nearest = options.find((m) => m >= current);

  // Keep the highlighted time in the middle of the list.
  useLayoutEffect(() => {
    if (open) listRef.current?.querySelector(".selected, .nearest")?.scrollIntoView({ block: "center" });
  }, [open, current]);

  const apply = (input: string) => {
    const parsed = parseTime(input);
    if (parsed && parsed !== value) onChange(parsed);
    return parsed;
  };

  /** A time clicked in the list wins over whatever was typed. */
  const picked = useRef<string | null>(null);

  const commit = () => {
    clearTimeout(liveTimer.current);
    focused.current = false;
    if (picked.current) {
      setText(label(picked.current));
      picked.current = null;
      return;
    }
    setText(label(apply(text) ?? value));
  };

  const type = (next: string) => {
    setText(next);
    clearTimeout(liveTimer.current);
    if (live) liveTimer.current = setTimeout(() => apply(next), LIVE_DELAY_MS);
  };

  return (
    <>
      <input
        ref={anchor}
        className={`field-button time-input${open ? " open" : ""}`}
        size={7}
        readOnly={touch}
        inputMode={touch ? "none" : undefined}
        value={text}
        disabled={disabled}
        onChange={(e) => type(e.target.value)}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
      />
      {open && (
        <Dropdown anchor={anchor} onClose={() => setOpen(false)} className="picker-times">
          <div ref={listRef} className="time-list">
            {options.map((m) => {
              const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
              const classes = [m === current && "selected", m === nearest && m !== current && "nearest"];
              return (
                <button
                  type="button"
                  key={m}
                  className={classes.filter(Boolean).join(" ")}
                  // Keep focus in the input so its blur doesn't commit stale text first.
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => {
                    picked.current = hhmm;
                    onChange(hhmm);
                    setOpen(false);
                    anchor.current?.blur();
                  }}
                >
                  <span>{label(hhmm)}</span>
                  {after && <span className="muted">{formatDuration(m - toMinutes(after))}</span>}
                </button>
              );
            })}
          </div>
        </Dropdown>
      )}
    </>
  );
}
