import { getAccessToken } from "./auth";
import { localTimeZone, parseDateOnly, toDateOnly } from "./dates";
import { demoCalendars, demoEvents, isDemo } from "./demo";

const API = "https://www.googleapis.com/calendar/v3";

export interface Calendar {
  id: string;
  summary: string;
  summaryOverride?: string;
  backgroundColor: string;
  primary?: boolean;
  selected?: boolean;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
  defaultReminders?: Reminder[];
}

export interface Reminder {
  method: "email" | "popup";
  minutes: number;
}

export interface Reminders {
  useDefault: boolean;
  overrides?: Reminder[];
}

export interface EventTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

export interface Attendee {
  email: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
}

export interface GoogleEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  eventType?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink: string;
  hangoutLink?: string;
  colorId?: string;
  start: EventTime;
  end: EventTime;
  recurringEventId?: string;
  /** For an occurrence of a recurring event: when it was scheduled before any change. */
  originalStartTime?: EventTime;
  recurrence?: string[];
  reminders?: Reminders;
  transparency?: "opaque" | "transparent";
  visibility?: "default" | "public" | "private" | "confidential";
  organizer?: { email?: string; self?: boolean };
  guestsCanModify?: boolean;
  attendees?: Attendee[];
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] };
}

export interface CalEvent {
  key: string;
  calendar: Calendar;
  event: GoogleEvent;
  title: string;
  start: Date;
  /** Exclusive. */
  end: Date;
  allDay: boolean;
  color: string;
  declined: boolean;
}

/** Fields we write. `null` clears a field. */
export interface EventInput {
  /** "confirmed" brings back a deleted event (Google keeps them as cancelled). */
  status?: "confirmed";
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  colorId?: string | null;
  transparency?: "opaque" | "transparent";
  visibility?: "default" | "public" | "private";
  attendees?: Attendee[];
  recurrence?: string[];
  /** Send `overrides: []` with `useDefault: true`, or Google keeps the old overrides. */
  reminders?: Reminders;
  conferenceData?: unknown;
}

/** Google's per-event color palette (colorId → hex). */
export const EVENT_COLORS: Record<string, string> = {
  "1": "#7986cb",
  "2": "#33b679",
  "3": "#8e24aa",
  "4": "#e67c73",
  "5": "#f6bf26",
  "6": "#f4511e",
  "7": "#039be5",
  "8": "#616161",
  "9": "#3f51b5",
  "10": "#0b8043",
  "11": "#d50000",
};

interface RequestOptions {
  method?: string;
  params?: Record<string, string>;
  body?: unknown;
}

async function api<T>(path: string, { method = "GET", params = {}, body }: RequestOptions = {}): Promise<T> {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const send = async (forceRefresh: boolean) =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await getAccessToken(forceRefresh)}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  let res = await send(false);
  if (res.status === 401) res = await send(true);
  // Back off and retry when over the per-minute quota, as Google recommends.
  for (let attempt = 0; attempt < 4 && (await isRateLimited(res)); attempt++) {
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.random() * 1000));
    res = await send(false);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error?.message ?? `Google Calendar request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

async function isRateLimited(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const err = await res.clone().json().catch(() => null);
  const reason = err?.error?.errors?.[0]?.reason;
  return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
}

async function paginate<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = await api<{ items?: T[]; nextPageToken?: string }>(path, {
      params: { ...params, ...(pageToken ? { pageToken } : {}) },
    });
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

export async function listCalendars(): Promise<Calendar[]> {
  if (isDemo) return demoCalendars;
  const calendars = await paginate<Calendar>("/users/me/calendarList", {});
  const rank = (c: Calendar) => (c.primary ? 0 : c.accessRole === "owner" ? 1 : 2);
  return calendars.sort((a, b) => rank(a) - rank(b) || calendarName(a).localeCompare(calendarName(b)));
}

export function calendarName(c: Calendar): string {
  return c.summaryOverride ?? c.summary;
}

export function isWritable(c: Calendar): boolean {
  return c.accessRole === "owner" || c.accessRole === "writer";
}

export function canEdit(ev: CalEvent): boolean {
  return isWritable(ev.calendar) && (ev.event.organizer?.self !== false || !!ev.event.guestsCanModify);
}

export async function listEvents(calendar: Calendar, timeMin: Date, timeMax: Date): Promise<CalEvent[]> {
  if (isDemo) return demoEvents(demoCalendars, timeMin, timeMax).filter((e) => e.calendar.id === calendar.id);
  const events = await paginate<GoogleEvent>(eventsPath(calendar), {
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    maxResults: "2500",
  });
  return events.flatMap((e) => toCalEvent(calendar, e) ?? []);
}

/** Full-text search (title, description, place, guests) over the past year and the next two. */
export async function searchEvents(calendars: Calendar[], query: string): Promise<CalEvent[]> {
  const now = Date.now();
  const timeMin = new Date(now - 365 * 86_400_000);
  const timeMax = new Date(now + 2 * 365 * 86_400_000);
  if (isDemo) {
    const q = query.toLowerCase();
    return demoEvents(demoCalendars, new Date(now - 21 * 86_400_000), new Date(now + 21 * 86_400_000)).filter((e) =>
      [e.title, e.event.location, e.event.description, ...(e.event.attendees ?? []).map((a) => a.email)].some((f) =>
        f?.toLowerCase().includes(q),
      ),
    );
  }
  const perCalendar = await Promise.all(
    calendars.map(async (calendar) => {
      const page = await api<{ items?: GoogleEvent[] }>(eventsPath(calendar), {
        params: {
          q: query,
          singleEvents: "true",
          orderBy: "startTime",
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          maxResults: "50",
        },
      }).catch(() => ({ items: [] }));
      return (page.items ?? []).flatMap((e) => toCalEvent(calendar, e) ?? []);
    }),
  );
  return perCalendar.flat();
}

const eventsPath = (calendar: Calendar, eventId?: string) =>
  `/calendars/${encodeURIComponent(calendar.id)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;

// Always notify guests, and opt in to conference data so Meet links can be created.
const WRITE_PARAMS = { sendUpdates: "all", conferenceDataVersion: "1" };

export async function createEvent(calendar: Calendar, input: EventInput): Promise<CalEvent> {
  if (isDemo) return demoWrite(calendar, { id: `demo-${crypto.randomUUID()}`, ...input });
  const event = await api<GoogleEvent>(eventsPath(calendar), { method: "POST", params: WRITE_PARAMS, body: input });
  return toCalEvent(calendar, event)!;
}

export async function updateEvent(ev: CalEvent, patch: EventInput): Promise<CalEvent> {
  if (isDemo) return demoWrite(ev.calendar, { ...ev.event, ...patch });
  const event = await api<GoogleEvent>(eventsPath(ev.calendar, ev.event.id), {
    method: "PATCH",
    params: WRITE_PARAMS,
    body: patch,
  });
  return toCalEvent(ev.calendar, event)!;
}

export async function deleteEvent(ev: CalEvent): Promise<void> {
  if (isDemo) return;
  await api(eventsPath(ev.calendar, ev.event.id), { method: "DELETE", params: { sendUpdates: "all" } });
}

export async function moveEvent(ev: CalEvent, destination: Calendar): Promise<CalEvent> {
  if (isDemo) return demoWrite(destination, ev.event);
  const event = await api<GoogleEvent>(`${eventsPath(ev.calendar, ev.event.id)}/move`, {
    method: "POST",
    params: { destination: destination.id, sendUpdates: "all" },
  });
  return toCalEvent(destination, event)!;
}

/** Demo mode: echo writes back as if Google accepted them. */
function demoWrite(calendar: Calendar, event: object): CalEvent {
  const e = event as Partial<GoogleEvent> & { conferenceData?: unknown; colorId?: string | null };
  return toCalEvent(calendar, {
    status: "confirmed",
    htmlLink: "https://calendar.google.com",
    ...event,
    colorId: e.colorId ?? undefined,
    hangoutLink: e.conferenceData ? "https://meet.google.com" : e.hangoutLink,
    conferenceData: undefined,
  } as GoogleEvent)!;
}

// --- Recurring events ---

/** Which occurrences a change to a recurring event applies to. */
export type RecurrenceScope = "this" | "following" | "all";

export function isRecurring(ev: CalEvent): boolean {
  return !!ev.event.recurringEventId && ev.key !== "draft";
}

const getEvent = (calendar: Calendar, eventId: string) => api<GoogleEvent>(eventsPath(calendar, eventId));

const patchEvent = (calendar: Calendar, eventId: string, body: unknown) =>
  api<GoogleEvent>(eventsPath(calendar, eventId), { method: "PATCH", params: WRITE_PARAMS, body });

function eventDate(t: EventTime): Date {
  return t.date ? parseDateOnly(t.date) : new Date(t.dateTime!);
}

/** RRULE UNTIL value ending a series just before `before`. */
function untilBefore(before: Date, allDay: boolean): string {
  if (allDay) return toDateOnly(new Date(before.getFullYear(), before.getMonth(), before.getDate() - 1)).replace(/-/g, "");
  return new Date(before.getTime() - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The series' rules, with each RRULE ending at `until` (or open-ended when `until` is null). */
function withUntil(recurrence: string[], until: string | null): string[] {
  return recurrence.map((line) => {
    if (!line.startsWith("RRULE:")) return line;
    const parts = line
      .slice(6)
      .split(";")
      .filter((p) => !/^(UNTIL|COUNT)=/.test(p));
    if (until) parts.push(`UNTIL=${until}`);
    return `RRULE:${parts.join(";")}`;
  });
}

/** Moves a series' first occurrence by the change made to one occurrence (shift + new duration). */
function shiftedSeriesTimes(master: GoogleEvent, ev: CalEvent, patch: EventInput): Pick<EventInput, "start" | "end"> {
  if (!patch.start || !patch.end) return {};
  const newStart = eventDate(patch.start);
  const newEnd = eventDate(patch.end);
  const start = new Date(eventDate(master.start).getTime() + (newStart.getTime() - ev.start.getTime()));
  const end = new Date(start.getTime() + (newEnd.getTime() - newStart.getTime()));
  const allDay = !!patch.start.date;
  if (allDay) return { start: { date: toDateOnly(start), dateTime: null }, end: { date: toDateOnly(end), dateTime: null } };
  const timeZone = master.start.timeZone ?? localTimeZone;
  return {
    start: { dateTime: start.toISOString(), date: null, timeZone },
    end: { dateTime: end.toISOString(), date: null, timeZone },
  };
}

/** Applies `patch` to the whole series, or to this occurrence and the ones after it. */
export async function updateSeries(ev: CalEvent, patch: EventInput, scope: Exclude<RecurrenceScope, "this">): Promise<void> {
  if (isDemo) return;
  const master = await getEvent(ev.calendar, ev.event.recurringEventId!);
  const originalStart = eventDate(ev.event.originalStartTime ?? ev.event.start);
  const isFirst = originalStart.getTime() <= eventDate(master.start).getTime();

  if (scope === "all" || isFirst) {
    await patchEvent(ev.calendar, master.id, { ...patch, ...shiftedSeriesTimes(master, ev, patch) });
    return;
  }

  // "This and following": end the original series before this occurrence…
  const allDay = !!master.start.date;
  await patchEvent(ev.calendar, master.id, {
    recurrence: withUntil(master.recurrence ?? [], untilBefore(originalStart, allDay)),
  });
  // …and start a new one from it, with the change applied.
  await api<GoogleEvent>(eventsPath(ev.calendar), {
    method: "POST",
    params: WRITE_PARAMS,
    body: {
      summary: master.summary,
      description: master.description,
      location: master.location,
      colorId: master.colorId,
      transparency: master.transparency,
      visibility: master.visibility,
      attendees: master.attendees?.map(({ email, displayName }) => ({ email, displayName })),
      reminders: master.reminders,
      recurrence: withUntil(master.recurrence ?? [], null),
      ...eventTimes(ev.start, ev.end, ev.allDay),
      ...patch,
    },
  });
}

/** Deletes the whole series, or this occurrence and the ones after it. */
export async function deleteSeries(ev: CalEvent, scope: Exclude<RecurrenceScope, "this">): Promise<void> {
  if (isDemo) return;
  const master = await getEvent(ev.calendar, ev.event.recurringEventId!);
  const originalStart = eventDate(ev.event.originalStartTime ?? ev.event.start);
  const isFirst = originalStart.getTime() <= eventDate(master.start).getTime();
  if (scope === "all" || isFirst) {
    await api(eventsPath(ev.calendar, master.id), { method: "DELETE", params: { sendUpdates: "all" } });
    return;
  }
  await patchEvent(ev.calendar, master.id, {
    recurrence: withUntil(master.recurrence ?? [], untilBefore(originalStart, !!master.start.date)),
  });
}

export function eventTimes(start: Date, end: Date, allDay: boolean): { start: EventTime; end: EventTime } {
  return allDay
    ? { start: { date: toDateOnly(start), dateTime: null }, end: { date: toDateOnly(end), dateTime: null } }
    : {
        start: { dateTime: start.toISOString(), date: null, timeZone: localTimeZone },
        end: { dateTime: end.toISOString(), date: null, timeZone: localTimeZone },
      };
}

export function meetRequest() {
  return { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
}

export function toCalEvent(calendar: Calendar, event: GoogleEvent): CalEvent | null {
  if (event.status === "cancelled" || event.eventType === "workingLocation") return null;
  const allDay = !!event.start.date;
  return {
    key: `${calendar.id}/${event.id}`,
    calendar,
    event,
    title: event.summary || "",
    start: allDay ? parseDateOnly(event.start.date!) : new Date(event.start.dateTime!),
    end: allDay ? parseDateOnly(event.end.date!) : new Date(event.end.dateTime!),
    allDay,
    color: (event.colorId && EVENT_COLORS[event.colorId]) || calendar.backgroundColor,
    declined: event.attendees?.some((a) => a.self && a.responseStatus === "declined") ?? false,
  };
}

export function meetingLink(event: GoogleEvent): string | undefined {
  return event.hangoutLink ?? event.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
}
