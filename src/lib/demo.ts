// Dev-only sample data: open http://localhost:1420/?demo to try the UI without a Google account.

import type { CalEvent, Calendar, GoogleEvent } from "./google";
import { addDays, startOfWeek, toDateOnly } from "./dates";

export const isDemo = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");

export const demoCalendars: Calendar[] = [
  { id: "me@example.com", summary: "me@example.com", backgroundColor: "#4285f4", primary: true, accessRole: "owner", defaultReminders: [{ method: "popup", minutes: 10 }] },
  { id: "work", summary: "Work", backgroundColor: "#33b679", accessRole: "owner" },
  { id: "sport", summary: "Sport", backgroundColor: "#f6bf26", accessRole: "owner" },
  { id: "holidays", summary: "Holidays", backgroundColor: "#e67c73", accessRole: "reader" },
];

const SAMPLES: [cal: number, day: number, start: number, end: number, title: string][] = [
  [1, 0, 9, 9.5, "Standup"],
  [1, 0, 10, 11.5, "Design review"],
  [0, 0, 12.5, 13.5, "Lunch with Sam"],
  [1, 1, 9, 9.5, "Standup"],
  [1, 1, 14, 16, "Focus time"],
  [0, 1, 15, 15.75, "Dentist"],
  [1, 2, 9, 9.5, "Standup"],
  [1, 2, 11, 12, "1:1"],
  [1, 2, 11.5, 12.5, "Interview"],
  [1, 2, 11.75, 13, "Planning"],
  [1, 3, 9, 9.5, "Standup"],
  [0, 3, 18, 19.5, "Gym"],
  [1, 3, 14, 14.25, "Call A"],
  [1, 3, 14.25, 14.5, "Call B"],
  [1, 3, 14.5, 14.75, "Call C"],
  [1, 4, 9, 9.5, "Standup"],
  [1, 4, 16, 17, "Demo day"],
  [0, 5, 10, 12, "Farmers market"],
  [0, 6, 19, 22, "Dinner party"],
];

const DEMO_PLACES: Record<string, string> = {
  "Lunch with Sam": "Café de Flore, 172 Boulevard Saint-Germain, 75006 Paris",
  Dentist: "12 Rue de Rivoli, 75004 Paris",
  Gym: "Basic-Fit, 40 Rue de la Gaîté, 75014 Paris",
};

const event = (id: string, extra: Partial<GoogleEvent>): GoogleEvent => ({
  id,
  status: "confirmed",
  htmlLink: "https://calendar.google.com",
  start: {},
  end: {},
  ...extra,
});

function demoWeek(calendars: Calendar[], week: Date): CalEvent[] {
  const at = (day: number, hours: number) => new Date(addDays(week, day).getTime() + hours * 3600_000);
  const id = (s: string) => `${week.toISOString().slice(0, 10)}-${s}`;
  const timed: CalEvent[] = SAMPLES.map(([cal, day, start, end, title], i) => ({
    key: `${calendars[cal].id}/${id(`t${i}`)}`,
    calendar: calendars[cal],
    event: event(id(`t${i}`), {
      summary: title,
      start: { dateTime: at(day, start).toISOString() },
      end: { dateTime: at(day, end).toISOString() },
      hangoutLink: cal === 1 ? "https://meet.google.com" : undefined,
      description: title === "Design review" ? "Agenda:<br>1. New sidebar<br>2. Event colors" : undefined,
      attendees: cal === 1 ? [{ email: "sam@example.com", responseStatus: "accepted" }] : undefined,
      recurringEventId: title === "Standup" ? "standup-series" : undefined,
      location: DEMO_PLACES[title],
      ...(title === "Design review"
        ? { attendees: [{ email: "sam@example.com", responseStatus: "accepted" as const }, { email: "maria.lopez@example.com", displayName: "Maria Lopez", responseStatus: "tentative" as const }] }
        : {}),
    }),
    title,
    start: at(day, start),
    end: at(day, end),
    allDay: false,
    color: calendars[cal].backgroundColor,
    declined: false,
  }));
  const allDay: CalEvent[] = [
    { title: "Conference", cal: 1, day: 1, span: 3 },
    { title: "Bank holiday", cal: 3, day: 4, span: 1 },
  ].map(({ title, cal, day, span }, i) => ({
    key: `${calendars[cal].id}/${id(`a${i}`)}`,
    calendar: calendars[cal],
    event: event(id(`a${i}`), {
      summary: title,
      start: { date: toDateOnly(addDays(week, day)) },
      end: { date: toDateOnly(addDays(week, day + span)) },
    }),
    title,
    start: addDays(week, day),
    end: addDays(week, day + span),
    allDay: true,
    color: calendars[cal].backgroundColor,
    declined: false,
  }));
  return [...timed, ...allDay];
}

export function demoEvents(calendars: Calendar[], from: Date, to: Date): CalEvent[] {
  const events: CalEvent[] = [];
  for (let week = startOfWeek(from, 1); week < to; week = addDays(week, 7)) events.push(...demoWeek(calendars, week));
  return events.filter((e) => e.start < to && e.end > from);
}
