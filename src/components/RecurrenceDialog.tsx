import { useEffect, useRef, useState } from "react";
import type { RecurrenceScope } from "../lib/google";
import type { StringKey } from "../lib/i18n";
import { useSettings } from "../lib/settings";

const OPTIONS: { scope: RecurrenceScope; label: StringKey }[] = [
  { scope: "this", label: "scopeThis" },
  { scope: "following", label: "scopeFollowing" },
  { scope: "all", label: "scopeAll" },
];

interface Props {
  kind: "edit" | "delete";
  onDone: (scope: RecurrenceScope | null) => void;
}

/** "This event / This and following / All events", asked before changing a recurring event. */
export function RecurrenceDialog({ kind, onDone }: Props) {
  const { t } = useSettings();
  const [scope, setScope] = useState<RecurrenceScope>("this");
  const ref = useRef<HTMLDivElement>(null);

  // Focus the dialog, not its button: the Enter that triggered it (e.g. saving a title) would
  // otherwise "click" the freshly focused button through its trailing keypress.
  useEffect(() => ref.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone(null);
      else if (e.key === "Enter") onDone(scope);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [scope, onDone]);

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <div ref={ref} tabIndex={-1} className="dialog recurrence-dialog" role="dialog" aria-modal="true">
        <h2>{t(kind === "edit" ? "editRecurring" : "deleteRecurring")}</h2>
        <div className="scope-options" role="radiogroup">
          {OPTIONS.map((o) => (
            <label key={o.scope} className="checkbox-row">
              <input type="radio" name="scope" checked={scope === o.scope} onChange={() => setScope(o.scope)} />
              {t(o.label)}
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="text-button" onClick={() => onDone(null)}>
            {t("cancel")}
          </button>
          <button className={`primary-button${kind === "delete" ? " danger" : ""}`} onClick={() => onDone(scope)}>
            {t(kind === "edit" ? "save" : "delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
