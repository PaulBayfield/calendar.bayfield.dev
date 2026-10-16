import { useState } from "react";
import type { Reminder, Reminders as RemindersValue } from "../lib/google";
import type { Translate } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { X } from "./icons";

/** Google allows at most five overrides per event, up to four weeks before. */
const MAX_REMINDERS = 5;
const MAX_MINUTES = 40320;
const PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
const UNITS = [
  { minutes: 1, label: "unitMinutes" },
  { minutes: 60, label: "unitHours" },
  { minutes: 1440, label: "unitDays" },
  { minutes: 10080, label: "unitWeeks" },
] as const;

export function reminderLabel(minutes: number, t: Translate): string {
  if (minutes === 0) return t("remindAtStart");
  if (minutes % 10080 === 0) return minutes === 10080 ? t("remindWeek") : t("remindWeeks", { n: minutes / 10080 });
  if (minutes % 1440 === 0) return minutes === 1440 ? t("remindDay") : t("remindDays", { n: minutes / 1440 });
  if (minutes % 60 === 0) return t("remindHours", { n: minutes / 60 });
  return t("remindMinutes", { n: minutes });
}

interface Props {
  value: RemindersValue;
  /** The calendar's defaults, used while `value.useDefault` is set. */
  defaults: Reminder[];
  editable: boolean;
  onChange: (next: RemindersValue) => void;
}

/** Reminder chips with an "add" menu. Editing a default list turns it into the event's own. */
export function Reminders({ value, defaults, editable, onChange }: Props) {
  const { t } = useSettings();
  const [custom, setCustom] = useState<{ amount: string; unit: number } | null>(null);
  const list = value.useDefault ? defaults : (value.overrides ?? []);

  const save = (overrides: Reminder[]) =>
    onChange({ useDefault: false, overrides: [...overrides].sort((a, b) => a.minutes - b.minutes) });
  const add = (minutes: number) => {
    setCustom(null);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_MINUTES) return;
    if (list.some((r) => r.method === "popup" && r.minutes === minutes)) return;
    save([...list, { method: "popup", minutes }]);
  };
  const submitCustom = () => custom && add(Math.round(Number(custom.amount) * custom.unit));

  return (
    <div className="reminders">
      {list.map((r) => (
        <span key={`${r.method}-${r.minutes}`} className={`reminder-chip${value.useDefault ? " default" : ""}`}>
          {reminderLabel(r.minutes, t)}
          {r.method === "email" && <span className="muted"> · {t("emailReminder")}</span>}
          {editable && (
            <button
              className="icon-button tiny"
              aria-label={t("delete")}
              onClick={() => save(list.filter((x) => x !== r))}
            >
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      {!list.length && <span className="muted small">{t("noReminders")}</span>}
      {value.useDefault && list.length > 0 && <span className="muted small">{t("byDefault")}</span>}

      {editable && !custom && list.length < MAX_REMINDERS && (
        <select
          className="reminder-add"
          value=""
          aria-label={t("addReminder")}
          onChange={(e) => {
            if (e.target.value === "custom") setCustom({ amount: "", unit: 1 });
            else add(Number(e.target.value));
          }}
        >
          <option value="" disabled>
            + {t("addReminder")}
          </option>
          {PRESETS.filter((m) => !list.some((r) => r.method === "popup" && r.minutes === m)).map((m) => (
            <option key={m} value={m}>
              {reminderLabel(m, t)}
            </option>
          ))}
          <option value="custom">{t("customReminder")}</option>
        </select>
      )}

      {custom && (
        <span className="reminder-custom">
          <input
            type="number"
            min={0}
            autoFocus
            value={custom.amount}
            onChange={(e) => setCustom({ ...custom, amount: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCustom();
              if (e.key === "Escape") {
                e.stopPropagation();
                setCustom(null);
              }
            }}
          />
          <select value={custom.unit} onChange={(e) => setCustom({ ...custom, unit: Number(e.target.value) })}>
            {UNITS.map((u) => (
              <option key={u.minutes} value={u.minutes}>
                {t(u.label)}
              </option>
            ))}
          </select>
          <button className="text-button" disabled={!custom.amount} onClick={submitCustom}>
            OK
          </button>
        </span>
      )}

      {editable && !value.useDefault && defaults.length > 0 && (
        <button className="link-button small" onClick={() => onChange({ useDefault: true, overrides: [] })}>
          {t("resetReminders")}
        </button>
      )}
    </div>
  );
}
