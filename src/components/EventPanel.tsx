import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  calendarName,
  canEdit,
  EVENT_COLORS,
  eventTimes,
  isWritable,
  meetingLink,
  meetRequest,
  type Attendee,
  type CalEvent,
  type Calendar,
  type EventInput,
} from "../lib/google";
import { addDays, fromDateAndTime, toDateOnly, toTimeOnly } from "../lib/dates";
import { openExternal } from "../lib/open";
import { useSettings } from "../lib/settings";
import type { StringKey } from "../lib/i18n";
import { PanelHeader } from "./PanelHeader";
import { DatePicker, formatDuration, TimePicker } from "./pickers";
import { Autocomplete } from "./Autocomplete";
import { suggestContacts } from "../lib/contacts";
import { endPlaceSession, rememberPlace, suggestPlaces } from "../lib/places";
import { AlignLeft, Clock, External, MapPin, Repeat, Trash, User, Video, X, PanelRight, PopOut, Lock } from "./icons";

const RECURRENCE: { value: string; label: StringKey }[] = [
  { value: "", label: "recNone" },
  { value: "RRULE:FREQ=DAILY", label: "recDaily" },
  { value: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", label: "recWeekdays" },
  { value: "RRULE:FREQ=WEEKLY", label: "recWeekly" },
  { value: "RRULE:FREQ=MONTHLY", label: "recMonthly" },
  { value: "RRULE:FREQ=YEARLY", label: "recYearly" },
];

interface Form {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
  colorId: string;
  transparency: "opaque" | "transparent";
  visibility: "default" | "public" | "private";
  recurrence: string;
  meet: boolean;
}

function formFrom(ev: CalEvent): Form {
  // All-day ends are exclusive in Google; show the inclusive last day.
  const end = ev.allDay ? addDays(ev.end, -1) : ev.end;
  const visibility = ev.event.visibility;
  return {
    title: ev.title,
    allDay: ev.allDay,
    startDate: toDateOnly(ev.start),
    startTime: toTimeOnly(ev.start),
    endDate: toDateOnly(end),
    endTime: toTimeOnly(end),
    location: ev.event.location ?? "",
    description: ev.event.description ? htmlToText(ev.event.description) : "",
    colorId: ev.event.colorId ?? "",
    transparency: ev.event.transparency ?? "opaque",
    visibility: visibility === "public" || visibility === "private" ? visibility : "default",
    recurrence: "",
    meet: false,
  };
}

function formTimes(form: Form): { start: Date; end: Date } {
  if (form.allDay) {
    const start = fromDateAndTime(form.startDate, "00:00");
    const last = fromDateAndTime(form.endDate, "00:00");
    return { start, end: addDays(last < start ? start : last, 1) };
  }
  const start = fromDateAndTime(form.startDate, form.startTime);
  const end = fromDateAndTime(form.endDate, form.endTime);
  return { start, end: end > start ? end : new Date(start.getTime() + 30 * 60_000) };
}

interface Props {
  ev: CalEvent;
  isDraft: boolean;
  calendars: Calendar[];
  onCreate: (calendar: Calendar, input: EventInput) => void;
  onUpdate: (ev: CalEvent, patch: EventInput) => void;
  onMoveCalendar: (ev: CalEvent, calendar: Calendar) => void;
  onDelete: (ev: CalEvent) => void;
  onDraftChange: (ev: CalEvent) => void;
  onClose: () => void;
  /** Shown as a floating card next to the event, or docked in the side panel. */
  variant: "popover" | "panel";
  /** Loaded events, mined for guest and place suggestions. */
  knownEvents: CalEvent[];
  onToggleVariant: () => void;
}

export function EventPanel({
  ev,
  isDraft,
  calendars,
  onCreate,
  onUpdate,
  onMoveCalendar,
  onDelete,
  onDraftChange,
  onClose,
  variant,
  onToggleVariant,
  knownEvents,
}: Props) {
  const { t, lang } = useSettings();
  const [form, setForm] = useState(() => formFrom(ev));
  const [attendees, setAttendees] = useState<Attendee[]>(ev.event.attendees ?? []);
  const [guest, setGuest] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const editable = isDraft || canEdit(ev);
  const writable = calendars.filter(isWritable);
  const isRecurring = !!ev.event.recurringEventId;

  // Reset when a different event is selected.
  useEffect(() => {
    setForm(formFrom(ev));
    setAttendees(ev.event.attendees ?? []);
    setGuest("");
    if (isDraft) setTimeout(() => titleRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ev.key]);

  // Follow external time changes (dragging the event on the grid, server responses).
  useEffect(() => {
    setForm((prev) => {
      const next = formFrom(ev);
      return {
        ...prev,
        allDay: next.allDay,
        startDate: next.startDate,
        startTime: next.startTime,
        endDate: next.endDate,
        endTime: next.endTime,
      };
    });
  }, [ev.start.getTime(), ev.end.getTime(), ev.allDay]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Drafts only update locally; existing events save each change straight away. */
  const commit = (patch: EventInput, nextForm: Form) => {
    if (isDraft) {
      const { start, end } = formTimes(nextForm);
      const calendar = ev.calendar;
      onDraftChange({
        ...ev,
        title: nextForm.title,
        start,
        end,
        allDay: nextForm.allDay,
        color: (nextForm.colorId && EVENT_COLORS[nextForm.colorId]) || calendar.backgroundColor,
        event: { ...ev.event, colorId: nextForm.colorId || undefined },
      });
    } else if (editable) {
      onUpdate(ev, patch);
    }
  };

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const commitTimes = (next: Form) => {
    setForm(next);
    const { start, end } = formTimes(next);
    commit(eventTimes(start, end, next.allDay), next);
  };

  /** Changing the start keeps the duration, like Notion/Google. */
  const changeStart = (date: string, time: string) => {
    const before = formTimes(form);
    const duration = before.end.getTime() - before.start.getTime();
    const start = fromDateAndTime(date, form.allDay ? "00:00" : time);
    if (Number.isNaN(start.getTime())) return;
    const end = new Date(start.getTime() + duration);
    const shownEnd = form.allDay ? addDays(end, -1) : end;
    commitTimes({
      ...form,
      startDate: date,
      startTime: time,
      endDate: toDateOnly(shownEnd),
      endTime: toTimeOnly(shownEnd),
    });
  };

  const commitText = (key: "title" | "location" | "description", field: "summary" | "location" | "description") => {
    const original = formFrom(ev)[key];
    if (form[key] !== original) commit({ [field]: form[key] }, form);
  };

  const create = () => {
    const { start, end } = formTimes(form);
    onCreate(ev.calendar, {
      summary: form.title,
      location: form.location || undefined,
      description: form.description || undefined,
      ...eventTimes(start, end, form.allDay),
      colorId: form.colorId || undefined,
      transparency: form.transparency,
      visibility: form.visibility,
      attendees: attendees.length ? attendees : undefined,
      recurrence: form.recurrence ? [form.recurrence] : undefined,
      conferenceData: form.meet ? meetRequest() : undefined,
    });
  };

  const addGuest = (value = guest) => {
    const email = value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || attendees.some((a) => a.email === email)) return;
    const next = [...attendees, { email }];
    setAttendees(next);
    setGuest("");
    if (!isDraft) onUpdate(ev, { attendees: next });
  };

  const removeGuest = (email: string) => {
    const next = attendees.filter((a) => a.email !== email);
    setAttendees(next);
    if (!isDraft) onUpdate(ev, { attendees: next });
  };

  const self = attendees.find((a) => a.self);
  const rsvp = (responseStatus: Attendee["responseStatus"]) => {
    const next = attendees.map((a) => (a.self ? { ...a, responseStatus } : a));
    setAttendees(next);
    onUpdate(ev, { attendees: next });
  };

  const meet = meetingLink(ev.event);
  const shownTimes = formTimes(form);
  const durationMinutes = Math.round((shownTimes.end.getTime() - shownTimes.start.getTime()) / 60_000);

  return (
    <>
      {variant === "popover" ? (
        <div className="popover-header">
          <span className="panel-label">{isDraft ? t("newEvent") : t("event")}</span>
          <div className="toolbar-spacer" />
          <button className="icon-button" title={t("openInPanel")} onClick={onToggleVariant}>
            <PanelRight />
          </button>
          <button className="icon-button" aria-label={t("close")} title={`${t("close")} (Esc)`} onClick={onClose}>
            <X />
          </button>
        </div>
      ) : (
        <PanelHeader label={isDraft ? t("newEvent") : t("event")} onClose={onClose}>
          <button className="icon-button" title={t("openAsPopup")} onClick={onToggleVariant}>
            <PopOut />
          </button>
        </PanelHeader>
      )}
      <div className="panel-body">
        <input
          ref={titleRef}
          className="panel-title-input"
          placeholder={t("newEvent")}
          value={form.title}
          disabled={!editable}
          onChange={(e) => {
            set("title", e.target.value);
            if (isDraft) commit({}, { ...form, title: e.target.value });
          }}
          onBlur={() => !isDraft && commitText("title", "summary")}
          onKeyDown={(e) => {
            if (e.key === "Enter") isDraft ? create() : (e.target as HTMLInputElement).blur();
          }}
        />
        {!editable && (
          <p className="panel-note read-only-note">
            <Lock size={12} /> {t("readOnly")}
          </p>
        )}

        <Section>
          <Row icon={<Clock />}>
            <div className="when">
              {!form.allDay && (
                <div className="when-line">
                  <TimePicker
                    value={form.startTime}
                    disabled={!editable}
                    onChange={(time) => changeStart(form.startDate, time)}
                  />
                  <span className="when-arrow">→</span>
                  <TimePicker
                    value={form.endTime}
                    disabled={!editable}
                    after={form.endDate === form.startDate ? form.startTime : undefined}
                    onChange={(time) => commitTimes({ ...form, endTime: time })}
                  />
                  <span className="muted small">{formatDuration(durationMinutes)}</span>
                </div>
              )}
              <div className="when-line">
                <DatePicker
                  value={form.startDate}
                  disabled={!editable}
                  onChange={(date) => changeStart(date, form.startTime)}
                />
                <span className="when-arrow">→</span>
                <DatePicker
                  value={form.endDate}
                  disabled={!editable}
                  onChange={(date) => commitTimes({ ...form, endDate: date < form.startDate ? form.startDate : date })}
                />
              </div>
            </div>
          </Row>
          <Row>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.allDay}
                disabled={!editable}
                onChange={(e) => {
                  const allDay = e.target.checked;
                  const next = allDay
                    ? { ...form, allDay }
                    : { ...form, allDay, startTime: "09:00", endDate: form.startDate, endTime: "09:30" };
                  commitTimes(next);
                }}
              />
              {t("allDay")}
            </label>
          </Row>
          {(isDraft || isRecurring || variant === "panel") && (
            <Row icon={<Repeat />}>
              {isDraft ? (
                <select value={form.recurrence} onChange={(e) => set("recurrence", e.target.value)}>
                  {RECURRENCE.map((r) => (
                    <option key={r.value} value={r.value}>
                      {t(r.label)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={isRecurring ? "small" : "muted small"}>
                  {isRecurring ? t("recurringInstance") : t("recNone")}
                </span>
              )}
            </Row>
          )}
        </Section>

        <Section>
          <Row icon={<User />}>
            <div className="guests">
              {attendees.map((a) => (
                <div key={a.email} className="guest">
                  <span className={`rsvp-dot ${a.responseStatus ?? "needsAction"}`} />
                  <span className="guest-name" title={a.email}>
                    {a.displayName ?? a.email}
                  </span>
                  {editable && !a.self && (
                    <button className="icon-button tiny" aria-label={t("delete")} onClick={() => removeGuest(a.email)}>
                      <X size={12} />
                    </button>
                  )}
                </div>
              ))}
              {editable && (
                <Autocomplete
                  className="ghost-input"
                  type="email"
                  placeholder={t("addParticipant")}
                  value={guest}
                  onChange={setGuest}
                  fetch={async (q) =>
                    (await suggestContacts(q, knownEvents, attendees.map((a) => a.email))).map((c) => ({
                      id: c.email,
                      value: c.email,
                      primary: c.name ?? c.email,
                      secondary: c.name ? c.email : undefined,
                      icon: <User size={14} />,
                    }))
                  }
                  onPick={(s) => addGuest(s.value)}
                  onCommit={() => addGuest()}
                />
              )}
            </div>
          </Row>
          {self && !self.organizer && !isDraft && (
            <Row>
              <span className="muted small">{t("going")}</span>
              <div className="segmented">
                {(["accepted", "declined", "tentative"] as const).map((s) => (
                  <button key={s} className={self.responseStatus === s ? "active" : ""} onClick={() => rsvp(s)}>
                    {t(s === "accepted" ? "yes" : s === "declined" ? "no" : "maybe")}
                  </button>
                ))}
              </div>
            </Row>
          )}
          <Row icon={<Video />}>
            {meet ? (
              <button className="primary-button" onClick={() => openExternal(meet)}>
                {t("join")}
              </button>
            ) : form.meet ? (
              <span className="small muted">{t("meetOnSave")}</span>
            ) : (
              editable && (
                <button
                  className="link-button"
                  onClick={() => (isDraft ? set("meet", true) : onUpdate(ev, { conferenceData: meetRequest() }))}
                >
                  {t("addMeet")}
                </button>
              )
            )}
          </Row>
          <Row icon={<MapPin />}>
            <Autocomplete
              className="ghost-input"
              placeholder={t("location")}
              value={form.location}
              disabled={!editable}
              onChange={(text) => set("location", text)}
              fetch={async (q) =>
                (await suggestPlaces(q, knownEvents, lang)).map((pl) => ({
                  place: pl,
                  id: pl.value,
                  value: pl.value,
                  primary: pl.main,
                  secondary: pl.secondary,
                  icon: pl.recent ? <Clock size={14} /> : <MapPin size={14} />,
                }))
              }
              onPick={(s) => {
                endPlaceSession();
                if (s.place) rememberPlace(s.place);
                const next = { ...form, location: s.value };
                setForm(next);
                if (s.value !== formFrom(ev).location) commit({ location: s.value }, next);
              }}
              onCommit={() => commitText("location", "location")}
            />
          </Row>
          <Row icon={<AlignLeft />}>
            <textarea
              className="ghost-input"
              placeholder={t("description")}
              rows={Math.min(8, Math.max(2, form.description.split("\n").length))}
              value={form.description}
              disabled={!editable}
              onChange={(e) => set("description", e.target.value)}
              onBlur={() => commitText("description", "description")}
            />
          </Row>
        </Section>

        <Section>
          <Row icon={<span className="swatch" style={{ "--c": ev.color } as CSSProperties} />}>
            {editable && !isRecurring && writable.length > 1 ? (
              <select
                value={ev.calendar.id}
                onChange={(e) => {
                  const calendar = writable.find((c) => c.id === e.target.value)!;
                  if (isDraft) {
                    onDraftChange({
                      ...ev,
                      calendar,
                      color: (form.colorId && EVENT_COLORS[form.colorId]) || calendar.backgroundColor,
                    });
                  } else onMoveCalendar(ev, calendar);
                }}
              >
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {calendarName(c)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="small">{calendarName(ev.calendar)}</span>
            )}
          </Row>
          {editable && (
            <Row>
              <div className="color-picker">
                <button
                  className={`color-dot${form.colorId ? "" : " active"}`}
                  style={{ "--c": ev.calendar.backgroundColor } as CSSProperties}
                  title={t("calendarColor")}
                  onClick={() => {
                    const next = { ...form, colorId: "" };
                    setForm(next);
                    commit({ colorId: null }, next);
                  }}
                />
                {Object.entries(EVENT_COLORS).map(([id, color]) => (
                  <button
                    key={id}
                    className={`color-dot${form.colorId === id ? " active" : ""}`}
                    style={{ "--c": color } as CSSProperties}
                    onClick={() => {
                      const next = { ...form, colorId: id };
                      setForm(next);
                      commit({ colorId: id }, next);
                    }}
                  />
                ))}
              </div>
            </Row>
          )}
          <Row>
            <div className="select-pair">
              <select
                value={form.transparency}
                disabled={!editable}
                onChange={(e) => {
                  const transparency = e.target.value as Form["transparency"];
                  setForm({ ...form, transparency });
                  commit({ transparency }, form);
                }}
              >
                <option value="opaque">{t("busy")}</option>
                <option value="transparent">{t("free")}</option>
              </select>
              <select
                value={form.visibility}
                disabled={!editable}
                onChange={(e) => {
                  const visibility = e.target.value as Form["visibility"];
                  setForm({ ...form, visibility });
                  commit({ visibility }, form);
                }}
              >
                <option value="default">{t("visDefault")}</option>
                <option value="public">{t("visPublic")}</option>
                <option value="private">{t("visPrivate")}</option>
              </select>
            </div>
          </Row>
        </Section>

        <div className="panel-footer">
          {isDraft ? (
            <>
              <button className="text-button" onClick={onClose}>
                {t("cancel")}
              </button>
              <button className="primary-button" onClick={create}>
                {t("create")}
              </button>
            </>
          ) : (
            <>
              {editable && (
                <button className="icon-button danger" title={`${t("delete")} (Del)`} onClick={() => onDelete(ev)}>
                  <Trash />
                </button>
              )}
              <button className="link-button with-icon" onClick={() => openExternal(ev.event.htmlLink)}>
                {t("openInGoogle")} <External size={13} />
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="panel-section">{children}</div>;
}

function Row({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel-row">
      <span className="panel-row-icon">{icon}</span>
      <div className="panel-row-content">{children}</div>
    </div>
  );
}

/** Google descriptions are HTML; edit them as plain text. */
function htmlToText(html: string): string {
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
  return (new DOMParser().parseFromString(withBreaks, "text/html").body.textContent ?? "").trim();
}
