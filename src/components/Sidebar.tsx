import { useEffect, useRef, useState, type CSSProperties } from "react";
import { calendarName, type Calendar } from "../lib/google";
import { addDays, addMonths, isSameDay, startOfWeek } from "../lib/dates";
import { useSettings } from "../lib/settings";
import { ChevronDown, ChevronUp, Compose, Grip, LinkIcon, PanelLeft, Search } from "./icons";

interface Props {
  calendars: Calendar[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
  rangeStart: Date;
  rangeEnd: Date;
  today: Date;
  onPickDate: (d: Date) => void;
  onNewEvent: () => void;
  onSearch: () => void;
  scheduling: boolean;
  onSchedule: () => void;
  onClose: () => void;
  onReorder: (ids: string[]) => void;
}

export function Sidebar(props: Props) {
  const { calendars, hidden, onToggle } = props;
  const { t } = useSettings();
  const mine = calendars.filter((c) => c.primary || c.accessRole === "owner");
  const others = calendars.filter((c) => !mine.includes(c));

  return (
    <aside className="sidebar">
      <div className="sidebar-top" data-tauri-drag-region>
        <button className="icon-button" title={`${t("toggleSidebar")} (Ctrl+B)`} onClick={props.onClose}>
          <PanelLeft />
        </button>
        <div className="toolbar-spacer" data-tauri-drag-region />
        <button className="icon-button" title={`${t("search")} (Ctrl+K)`} onClick={props.onSearch}>
          <Search />
        </button>
        <button className="icon-button" title={`${t("newEvent")} (C)`} onClick={props.onNewEvent}>
          <Compose />
        </button>
      </div>
      <MiniMonth {...props} />
      <button className={`sidebar-row${props.scheduling ? " active" : ""}`} onClick={props.onSchedule}>
        <LinkIcon />
        <span>{t("schedule")}</span>
      </button>
      <CalendarGroup
        title={t("myCalendars")}
        calendars={mine}
        hidden={hidden}
        onToggle={onToggle}
        onReorder={(ids) => props.onReorder([...ids, ...others.map((c) => c.id)])}
      />
      {others.length > 0 && (
        <CalendarGroup
          title={t("otherCalendars")}
          calendars={others}
          hidden={hidden}
          onToggle={onToggle}
          onReorder={(ids) => props.onReorder([...mine.map((c) => c.id), ...ids])}
        />
      )}
    </aside>
  );
}

function MiniMonth({ rangeStart, rangeEnd, today, onPickDate }: Props) {
  const { f, settings } = useSettings();
  const [month, setMonth] = useState(() => addMonths(rangeStart, 0));
  useEffect(() => setMonth(addMonths(rangeStart, 0)), [rangeStart]);

  const gridStart = startOfWeek(month, settings.weekStartsOn);
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(gridStart, w * 7 + d)));
  const inRange = (d: Date) => d >= rangeStart && d < rangeEnd;

  return (
    <div className="mini-month">
      <div className="mini-month-head">
        <span className="mini-month-title">{f.monthYear(month)}</span>
        <button className="icon-button small" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronUp />
        </button>
        <button className="icon-button small" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronDown />
        </button>
      </div>
      <div className="mini-month-row">
        {weeks[0].map((d) => (
          <span key={d.getDay()} className="mini-weekday">
            {f.weekdayMini(d)}
          </span>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0].toISOString()} className="mini-month-row">
          {week.map((d, i) => {
            const on = inRange(d);
            const classes = [
              "mini-day",
              d.getMonth() !== month.getMonth() && "outside",
              on && "in-range",
              on && (i === 0 || !inRange(week[i - 1])) && "range-start",
              on && (i === 6 || !inRange(week[i + 1])) && "range-end",
              isSameDay(d, today) && "today",
            ];
            return (
              <button key={i} className={classes.filter(Boolean).join(" ")} onClick={() => onPickDate(d)}>
                <span>{d.getDate()}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface GroupProps {
  title: string;
  calendars: Calendar[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
  onReorder: (ids: string[]) => void;
}

interface RowDrag {
  id: string;
  from: number;
  over: number;
  startY: number;
  dy: number;
  /** Row midpoints (client Y) at drag start. */
  mids: number[];
  rowHeight: number;
}

/** A calendar list whose rows can be dragged (by their grip) into a new order. */
function CalendarGroup({ title, calendars, hidden, onToggle, onReorder }: GroupProps) {
  const { t } = useSettings();
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<RowDrag | null>(null);
  // Pointer handlers read this ref: a fast release can arrive before React re-renders.
  const dragRef = useRef<RowDrag | null>(null);
  const setDrag = (d: RowDrag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const ids = calendars.map((c) => c.id);

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    onReorder(next);
  };

  const onGripDown = (index: number, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rows = [...listRef.current!.querySelectorAll<HTMLElement>(".calendar-item")];
    const rects = rows.map((r) => r.getBoundingClientRect());
    setDrag({
      id: ids[index],
      from: index,
      over: index,
      startY: e.clientY,
      dy: 0,
      mids: rects.map((r) => r.top + r.height / 2),
      rowHeight: rects[0]?.height ?? 30,
    });
  };

  const onGripMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const y = e.clientY;
    let over = drag.mids.findIndex((mid) => y < mid);
    if (over === -1) over = drag.mids.length - 1;
    else if (over > drag.from) over -= 1;
    setDrag({ ...drag, dy: y - drag.startY, over });
  };

  const onGripUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    setDrag(null);
    move(drag.from, drag.over);
  };

  /** Where each row sits while dragging: the dragged one follows the pointer, the rest make room. */
  const offset = (index: number) => {
    if (!drag) return 0;
    if (index === drag.from) return drag.dy;
    if (drag.from < index && index <= drag.over) return -drag.rowHeight;
    if (drag.over <= index && index < drag.from) return drag.rowHeight;
    return 0;
  };

  return (
    <div className={`calendar-group${drag ? " reordering" : ""}`} ref={listRef}>
      <div className="calendar-group-title">{title}</div>
      {calendars.map((c, i) => (
        <label
          key={c.id}
          className={`calendar-item${drag?.id === c.id ? " dragging" : ""}`}
          style={{ "--c": c.backgroundColor, transform: `translateY(${offset(i)}px)` } as CSSProperties}
        >
          <input
            type="checkbox"
            checked={!hidden.has(c.id)}
            onChange={() => onToggle(c.id)}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
              e.preventDefault();
              const to = Math.min(ids.length - 1, Math.max(0, i + (e.key === "ArrowUp" ? -1 : 1)));
              move(i, to);
            }}
          />
          <span className="calendar-check" />
          <span className="calendar-name">{calendarName(c)}</span>
          {calendars.length > 1 && (
            <span
              className="calendar-grip"
              title={t("reorder")}
              onPointerDown={(e) => onGripDown(i, e)}
              onPointerMove={onGripMove}
              onPointerUp={onGripUp}
              onPointerCancel={() => setDrag(null)}
              onClick={(e) => e.preventDefault()} // Don't toggle the checkbox.
            >
              <Grip size={14} />
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
