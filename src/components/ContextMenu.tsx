import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { calendarName, canEdit, EVENT_COLORS, isWritable, type CalEvent, type Calendar } from "../lib/google";
import { useSettings } from "../lib/settings";
import { CalendarIcon, Check, ChevronRight, ClipboardPaste, Compose, Copy, CopyPlus, Scissors, Trash } from "./icons";

const MARGIN = 8;

/** Where the menu was opened, and on what. */
export type MenuTarget = { x: number; y: number } & ({ kind: "event"; ev: CalEvent } | { kind: "slot"; time: Date });

export interface MenuActions {
  canPaste: boolean;
  calendars: Calendar[];
  /** Events the menu acts on: the clicked one, or the whole selection it belongs to. */
  group: CalEvent[];
  onColor: (evs: CalEvent[], colorId: string | null) => void;
  onBlockOn: (evs: CalEvent[], calendar: Calendar) => void;
  onCut: (evs: CalEvent[]) => void;
  onCopy: (evs: CalEvent[]) => void;
  onDuplicate: (evs: CalEvent[]) => void;
  onDelete: (evs: CalEvent[]) => void;
  onPaste: (time: Date) => void;
  onNewEvent: (time: Date) => void;
}

/** Right-click menu for an event or an empty slot of the grid. */
export function ContextMenu({ target, onClose, ...a }: MenuActions & { target: MenuTarget; onClose: () => void }) {
  const { t } = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [submenu, setSubmenu] = useState(false);

  // Open at the pointer, kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current!;
    setPos({
      left: Math.min(target.x, window.innerWidth - el.offsetWidth - MARGIN),
      top: Math.min(target.y, window.innerHeight - el.offsetHeight - MARGIN),
    });
  }, [target]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  // Open the submenu on the left when there's no room on the right.
  const flipSubmenu = !!pos && pos.left + (ref.current?.offsetWidth ?? 260) + 220 > window.innerWidth;

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  let body: ReactNode;
  if (target.kind === "slot") {
    const { time } = target;
    body = (
      <>
        <Item icon={<ClipboardPaste />} label={t("paste")} shortcut="Ctrl V" disabled={!a.canPaste} onClick={run(() => a.onPaste(time))} />
        <Item icon={<Compose />} label={t("newEvent")} shortcut="C" onClick={run(() => a.onNewEvent(time))} />
      </>
    );
  } else {
    const { ev } = target;
    const group = a.group.length ? a.group : [ev];
    const editable = group.some(canEdit);
    const others = a.calendars.filter((c) => isWritable(c) && c.id !== ev.calendar.id);
    body = (
      <>
        {group.length > 1 && <div className="menu-label">{t("nEvents", { n: group.length })}</div>}
        {editable && (
          <>
            <div className="menu-colors">
              {[null, ...Object.keys(EVENT_COLORS)].map((id) => {
                const color = id ? EVENT_COLORS[id] : ev.calendar.backgroundColor;
                const active = (ev.event.colorId ?? null) === id;
                return (
                  <button
                    key={id ?? "calendar"}
                    className="menu-color"
                    style={{ "--c": color } as CSSProperties}
                    title={id ? undefined : t("calendarColor")}
                    onClick={run(() => a.onColor(group, id))}
                  >
                    {active && <Check size={11} />}
                  </button>
                );
              })}
            </div>
            <div className="menu-separator" />
          </>
        )}
        {others.length > 0 && (
          <div className="menu-sub-anchor" onMouseEnter={() => setSubmenu(true)} onMouseLeave={() => setSubmenu(false)}>
            <Item icon={<CalendarIcon />} label={t("blockOn")} trailing={<ChevronRight size={14} />} onClick={() => setSubmenu(!submenu)} />
            {submenu && (
              <div className={`context-menu submenu${flipSubmenu ? " flip" : ""}`}>
                {others.map((c) => (
                  <Item
                    key={c.id}
                    icon={<span className="swatch" style={{ "--c": c.backgroundColor } as CSSProperties} />}
                    label={calendarName(c)}
                    onClick={run(() => a.onBlockOn(group, c))}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {others.length > 0 && <div className="menu-separator" />}
        <Item icon={<Scissors />} label={t("cut")} shortcut="Ctrl X" disabled={!editable} onClick={run(() => a.onCut(group))} />
        <Item icon={<Copy />} label={t("copy")} shortcut="Ctrl C" onClick={run(() => a.onCopy(group))} />
        <Item icon={<CopyPlus />} label={t("duplicate")} shortcut="Ctrl D" onClick={run(() => a.onDuplicate(group))} />
        <div className="menu-separator" />
        <Item icon={<Trash />} label={t("delete")} shortcut={t("deleteKey")} danger disabled={!editable} onClick={run(() => a.onDelete(group))} />
      </>
    );
  }

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={pos ?? { left: -9999, top: 0, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {body}
    </div>,
    document.body,
  );
}

function Item(p: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  trailing?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button role="menuitem" className={`menu-item${p.danger ? " danger" : ""}`} disabled={p.disabled} onClick={p.onClick}>
      <span className="menu-item-icon">{p.icon}</span>
      <span className="menu-item-label">{p.label}</span>
      {p.shortcut && <span className="menu-item-shortcut">{p.shortcut}</span>}
      {p.trailing}
    </button>
  );
}
