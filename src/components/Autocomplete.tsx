import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dropdown } from "./pickers";
import type { Place } from "../lib/places";

export interface Suggestion {
  id: string;
  /** Inserted when picked. */
  value: string;
  primary: string;
  secondary?: string;
  icon?: ReactNode;
  /** Source object, handed back on pick. */
  place?: Place;
}

interface Props {
  value: string;
  onChange: (text: string) => void;
  /** Look up suggestions for the current text (debounced; stale answers are ignored). */
  fetch: (text: string) => Promise<Suggestion[]>;
  onPick: (s: Suggestion) => void;
  /** Enter without a highlighted suggestion, or leaving the field. */
  onCommit: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  type?: string;
}

const DEBOUNCE_MS = 180;

/** A text input with a suggestion list underneath. */
export function Autocomplete({ value, onChange, fetch, onPick, onCommit, placeholder, disabled, className, type }: Props) {
  const anchor = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const request = useRef(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    if (!open) return;
    const id = ++request.current;
    const timer = setTimeout(async () => {
      const found = await fetchRef.current(value).catch(() => []);
      if (id !== request.current) return;
      setItems(found);
      setActive(-1);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, open]);

  const pick = (s: Suggestion) => {
    onPick(s);
    setItems([]);
    setOpen(false);
  };

  const showList = open && items.length > 0;

  return (
    <>
      <input
        ref={anchor}
        className={className}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          onCommit();
        }}
        onKeyDown={(e) => {
          if (showList && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            const n = items.length;
            setActive((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (showList && active >= 0) pick(items[active]);
            else {
              setOpen(false);
              onCommit();
            }
          } else if (e.key === "Escape" && showList) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {showList && (
        <Dropdown anchor={anchor} onClose={() => setOpen(false)} className="suggestions">
          {items.map((s, i) => (
            <button
              type="button"
              key={s.id}
              className={`suggestion${i === active ? " active" : ""}`}
              // Keep focus in the input so its blur doesn't commit the half-typed text first.
              onPointerDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(s)}
            >
              {s.icon && <span className="suggestion-icon">{s.icon}</span>}
              <span className="suggestion-text">
                <span className="suggestion-primary">{s.primary}</span>
                {s.secondary && <span className="suggestion-secondary">{s.secondary}</span>}
              </span>
            </button>
          ))}
        </Dropdown>
      )}
    </>
  );
}
