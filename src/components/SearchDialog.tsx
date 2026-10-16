import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { searchEvents, type CalEvent, type Calendar } from "../lib/google";
import { useSettings } from "../lib/settings";
import { Search } from "./icons";

const DEBOUNCE_MS = 250;
const MAX_RESULTS = 40;

interface Props {
  calendars: Calendar[];
  /** Already-loaded events: matched instantly while Google is searched. */
  knownEvents: CalEvent[];
  onPick: (ev: CalEvent) => void;
  onClose: () => void;
}

function matchText(ev: CalEvent, q: string): string | undefined {
  const fields = [
    ev.title,
    ev.event.location,
    ...(ev.event.attendees ?? []).flatMap((a) => [a.email, a.displayName ?? ""]),
    ev.event.description?.replace(/<[^>]+>/g, " "),
  ];
  return fields.find((f) => f?.toLowerCase().includes(q));
}

/** Command-palette style search over events: title, place, guests, description. */
export function SearchDialog({ calendars, knownEvents, onPick, onClose }: Props) {
  const { t, f } = useSettings();
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();

  useEffect(() => {
    setRemote([]);
    if (q.length < 2) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      searchEvents(calendars, q)
        .then((found) => !cancelled && setRemote(found))
        .finally(() => !cancelled && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setLoading(false);
    };
  }, [q, calendars]);

  /** Upcoming first (soonest first), then past (most recent first). */
  const { upcoming, past } = useMemo(() => {
    if (!q) return { upcoming: [], past: [] };
    const byKey = new Map<string, CalEvent>();
    for (const ev of [...knownEvents, ...remote]) if (matchText(ev, q)) byKey.set(ev.key, ev);
    const now = Date.now();
    const all = [...byKey.values()];
    return {
      upcoming: all.filter((e) => e.end.getTime() >= now).sort((a, b) => a.start.getTime() - b.start.getTime()),
      past: all.filter((e) => e.end.getTime() < now).sort((a, b) => b.start.getTime() - a.start.getTime()),
    };
  }, [q, knownEvents, remote]);
  const results = [...upcoming, ...past].slice(0, MAX_RESULTS);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".search-result.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const row = (ev: CalEvent, i: number) => {
    const hit = matchText(ev, q);
    const extra = hit && hit !== ev.title ? hit : ev.event.location;
    const when = ev.allDay ? f.shortDate(ev.start) : `${f.shortDate(ev.start)} · ${f.time(ev.start)}`;
    return (
      <button
        key={ev.key}
        className={`search-result${i === active ? " active" : ""}`}
        onMouseEnter={() => setActive(i)}
        onClick={() => onPick(ev)}
      >
        <span className="swatch" style={{ "--c": ev.color } as CSSProperties} />
        <span className="search-result-text">
          <span className="search-result-title">{ev.title || t("untitled")}</span>
          {extra && <span className="search-result-extra">{extra}</span>}
        </span>
        <span className="search-result-when">{when}</span>
      </button>
    );
  };

  return (
    <div className="dialog-backdrop search-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-dialog" role="dialog" aria-label={t("search")}>
        <div className="search-input-row">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            placeholder={t("searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") setActive((i) => Math.min(results.length - 1, i + 1));
              else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
              else if (e.key === "Enter" && results[active]) onPick(results[active]);
              else return;
              e.preventDefault();
              e.stopPropagation();
            }}
          />
          {loading && <span className="spinner" />}
        </div>
        {q && (
          <div className="search-results" ref={listRef}>
            {results.length === 0 && !loading && <p className="search-empty">{t("noResults")}</p>}
            {upcoming.length > 0 && <div className="search-section">{t("upcoming")}</div>}
            {results.slice(0, Math.min(upcoming.length, MAX_RESULTS)).map((ev, i) => row(ev, i))}
            {past.length > 0 && upcoming.length < MAX_RESULTS && <div className="search-section">{t("past")}</div>}
            {results.slice(upcoming.length).map((ev, i) => row(ev, i + upcoming.length))}
          </div>
        )}
      </div>
    </div>
  );
}
