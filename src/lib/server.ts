// Client for the scheduling server (server/). Owner requests are authenticated with the
// same Google access token the app already has; the server checks it belongs to OWNER_EMAIL.

import { getAccessToken, isTauri } from "./auth";

export interface Slot {
  start: Date;
  end: Date;
}

export interface LinkInput {
  title: string;
  duration: number;
  slots: Slot[];
  calendarId: string;
  busyCalendarIds: string[];
  meet: boolean;
  singleUse: boolean;
  timeZone: string;
}

export interface Booking {
  id: string;
  start: string;
  end: string;
  name: string;
  email: string;
}

export interface ScheduleLink {
  id: string;
  url: string;
  title: string;
  duration: number;
  singleUse: boolean;
  createdAt: string;
  bookings: Booking[];
}

export interface WeatherDay {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  /** Today and later come from the forecast; earlier days are observations. */
  forecast: boolean;
  max: number | null;
  min: number | null;
  precipitation: number | null;
  code: number | null;
  feelsMax?: number | null;
  feelsMin?: number | null;
  /** Percent. */
  precipitationProbability?: number | null;
  /** km/h. */
  wind?: number | null;
  gusts?: number | null;
  uv?: number | null;
  /** Local "YYYY-MM-DDTHH:MM". */
  sunrise?: string | null;
  sunset?: string | null;
}

export interface WeatherCurrent {
  time: string;
  temperature: number | null;
  feels: number | null;
  humidity: number | null;
  code: number | null;
  wind: number | null;
  isDay: boolean | null;
}

export interface WeatherCity {
  /** The city actually served: the requested one, or the first known if that's unknown. */
  city: string;
  cities: string[];
  current: WeatherCurrent | null;
  days: WeatherDay[];
  updatedAt: string | null;
}

export interface ServerStatus {
  connected: boolean;
  email?: string;
}

/** Empty string means the server isn't configured (desktop) — the web build uses its own origin. */
export function serverBase(serverUrl: string): string {
  if (serverUrl) return serverUrl.replace(/\/+$/, "");
  return isTauri ? "" : location.origin;
}

async function call<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `Scheduling server error (${res.status})`);
  }
  return res.json();
}

export const getServerStatus = (base: string) => call<ServerStatus>(base, "/api/status");

export const getWeather = (base: string, city: string) =>
  call<WeatherCity>(base, `/api/weather?city=${encodeURIComponent(city)}`);

export const getConnectUrl = (base: string) => call<{ url: string }>(base, "/api/google/connect", { method: "POST" });

export const listLinks = (base: string) => call<ScheduleLink[]>(base, "/api/links");

export const createLink = (base: string, input: LinkInput) =>
  call<ScheduleLink>(base, "/api/links", { method: "POST", body: JSON.stringify(input) });

export const deleteLink = (base: string, id: string) =>
  call<{ ok: true }>(base, `/api/links/${encodeURIComponent(id)}`, { method: "DELETE" });
