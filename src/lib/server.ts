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

export const getConnectUrl = (base: string) => call<{ url: string }>(base, "/api/google/connect", { method: "POST" });

export const listLinks = (base: string) => call<ScheduleLink[]>(base, "/api/links");

export const createLink = (base: string, input: LinkInput) =>
  call<ScheduleLink>(base, "/api/links", { method: "POST", body: JSON.stringify(input) });

export const deleteLink = (base: string, id: string) =>
  call<{ ok: true }>(base, `/api/links/${encodeURIComponent(id)}`, { method: "DELETE" });
