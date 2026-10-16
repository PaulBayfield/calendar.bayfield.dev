import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MOBILE_QUERY, useMediaQuery } from "../lib/useMediaQuery";

const MARGIN = 8;

interface Props {
  /** Key of the event to sit next to; its grid element carries `data-event-key`. */
  eventKey: string;
  onClose: () => void;
  children: ReactNode;
}

/** Floating, frosted-glass card anchored beside an event on the grid; a bottom sheet on phones. */
export function EventPopover({ eventKey, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const sheet = useMediaQuery(MOBILE_QUERY);

  // Keep it beside the event as the grid scrolls, the window resizes or the card grows.
  useLayoutEffect(() => {
    if (sheet) return;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const card = ref.current;
        const anchor = document.querySelector(`[data-event-key="${CSS.escape(eventKey)}"]`);
        if (!card || !anchor) return;
        const r = anchor.getBoundingClientRect();
        const w = card.offsetWidth;
        const h = card.offsetHeight;
        const fitsRight = r.right + MARGIN + w <= window.innerWidth - MARGIN;
        const left = fitsRight ? r.right + MARGIN : Math.max(MARGIN, r.left - MARGIN - w);
        const top = Math.min(Math.max(MARGIN, r.top), window.innerHeight - h - MARGIN);
        setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
      });
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(ref.current!);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // The event itself can move (drag, save, navigation) without this component re-rendering.
    const grid = document.querySelector(".week");
    const mutations = new MutationObserver(place);
    if (grid) mutations.observe(grid, { subtree: true, attributes: true, attributeFilter: ["style"], childList: true });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [eventKey, sheet]);

  // Clicks outside close it. The grid handles its own clicks (selecting another event, deselecting).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!target.closest(".popover, .picker, .week, .menu, .dialog-backdrop, .toast")) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  if (sheet) {
    return (
      <>
        {/* Closed by the outside-press handler above. No onClick: the tap that opened the sheet
            fires a late click that would land here and close it again. */}
        <div className="sheet-backdrop" />
        <div ref={ref} className="popover sheet" role="dialog">
          <div className="sheet-handle" />
          {children}
        </div>
      </>
    );
  }

  return (
    <div
      ref={ref}
      className="popover"
      role="dialog"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: "hidden" }}
    >
      {children}
    </div>
  );
}
