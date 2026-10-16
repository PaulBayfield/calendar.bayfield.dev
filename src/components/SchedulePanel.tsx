import { useCallback, useEffect, useState } from "react";
import { calendarName, isWritable, type Calendar } from "../lib/google";
import { createLink, deleteLink, listLinks, serverBase, type ScheduleLink, type Slot } from "../lib/server";
import { localTimeZone } from "../lib/dates";
import { useSettings } from "../lib/settings";
import { PanelHeader } from "./PanelHeader";
import { Check, Copy, Trash, X } from "./icons";

const DURATIONS = [15, 30, 45, 60, 90, 120];

interface Props {
  slots: Slot[];
  calendars: Calendar[];
  hidden: Set<string>;
  onRemoveSlot: (index: number) => void;
  onClearSlots: () => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}

export function SchedulePanel({ slots, calendars, hidden, onRemoveSlot, onClearSlots, onClose, onError }: Props) {
  const { t, f, settings } = useSettings();
  const base = serverBase(settings.serverUrl);
  const writable = calendars.filter(isWritable);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(30);
  const [calendarId, setCalendarId] = useState(settings.defaultCalendarId ?? writable[0]?.id ?? "");
  const [meet, setMeet] = useState(true);
  const [singleUse, setSingleUse] = useState(true);
  const [links, setLinks] = useState<ScheduleLink[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (base) listLinks(base).then(setLinks).catch(onError);
  }, [base, onError]);
  useEffect(refresh, [refresh]);

  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(url);
    setTimeout(() => setCopied(null), 2000);
  };

  const create = async () => {
    setBusy(true);
    try {
      const link = await createLink(base, {
        title: title.trim() || t("schedule"),
        duration,
        slots,
        calendarId,
        // Check the calendars you can see and own for conflicts.
        busyCalendarIds: calendars.filter((c) => isWritable(c) && !hidden.has(c.id)).map((c) => c.id),
        meet,
        singleUse,
        timeZone: localTimeZone,
      });
      await copy(link.url);
      onClearSlots();
      setTitle("");
      refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const fitting = slots.filter((s) => s.end.getTime() - s.start.getTime() >= duration * 60_000);

  return (
    <>
      <PanelHeader label={t("schedule")} onClose={onClose} />
      <div className="panel-body">
        {!base ? (
          <p className="panel-note">{t("serverNotConfigured")}</p>
        ) : (
          <>
            <p className="panel-note">{t("scheduleHint")}</p>
            <input
              className="panel-title-input"
              placeholder={t("meetingTitle")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="panel-section">
              <label className="field">
                <span>{t("duration")}</span>
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {t("minutes", { n: d })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("defaultCalendar")}</span>
                <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
                  {writable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {calendarName(c)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={meet} onChange={(e) => setMeet(e.target.checked)} />
                {t("addMeet")}
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={singleUse} onChange={(e) => setSingleUse(e.target.checked)} />
                {t("singleUse")}
              </label>
            </div>

            <div className="panel-section">
              <div className="panel-subtitle">{t("slots")}</div>
              {slots.length === 0 && <p className="muted small">{t("noSlots")}</p>}
              {slots.map((s, i) => (
                <div key={i} className="slot-row">
                  <span>
                    {f.shortDate(s.start)} · {f.time(s.start)} – {f.time(s.end)}
                  </span>
                  <button className="icon-button tiny" aria-label={t("delete")} onClick={() => onRemoveSlot(i)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button
                className="primary-button"
                disabled={busy || fitting.length === 0 || !calendarId}
                onClick={create}
              >
                {t("copyLink")}
              </button>
            </div>

            {links && links.length > 0 && (
              <div className="panel-section">
                <div className="panel-subtitle">{t("yourLinks")}</div>
                {links.map((link) => (
                  <div key={link.id} className="link-card">
                    <div className="link-card-head">
                      <span className="link-title">{link.title}</span>
                      <span className="muted small">{t("minutes", { n: link.duration })}</span>
                      <button className="icon-button tiny" title={t("copy")} onClick={() => copy(link.url)}>
                        {copied === link.url ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                      <button
                        className="icon-button tiny danger"
                        title={t("delete")}
                        onClick={() => deleteLink(base, link.id).then(refresh, onError)}
                      >
                        <Trash size={13} />
                      </button>
                    </div>
                    {link.bookings.length === 0 ? (
                      <span className="muted small">{t("noBookings")}</span>
                    ) : (
                      link.bookings.map((b) => (
                        <span key={b.id} className="small">
                          {t("bookedBy", { name: b.name })} · {f.shortDate(new Date(b.start))}{" "}
                          {f.time(new Date(b.start))}
                        </span>
                      ))
                    )}
                  </div>
                ))}
              </div>
            )}
            {copied && <div className="toast">{t("linkCopied")}</div>}
          </>
        )}
      </div>
    </>
  );
}
