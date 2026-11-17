// Client for the scheduling server (server/). Owner requests are authenticated with the
// same Google access token the app already has; the server checks it belongs to OWNER_EMAIL.

import { getAccessToken, isTauri } from "./auth";
import { isDemo } from "./demo";

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
  if (isDemo && path.startsWith("/api/board")) return structuredClone(demoBoard(path, init)) as T;
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

// --- Tasks board ---

export interface TodoColumn {
  id: string;
  name: string;
  position: number;
}

export interface Todo {
  id: string;
  columnId: string;
  title: string;
  notes: string;
  position: number;
  /** "YYYY-MM-DD", local day. */
  dueDate: string | null;
  /** "HH:MM"; null for a whole-day deadline. */
  dueTime: string | null;
  /** The Google event showing the deadline. */
  calendarId: string | null;
  eventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TodoPatch = Partial<Pick<Todo, "columnId" | "title" | "notes" | "position" | "dueDate" | "dueTime" | "calendarId" | "eventId">>;

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const getBoard = (base: string) => call<{ columns: TodoColumn[]; todos: Todo[] }>(base, "/api/board");

export const createColumn = (base: string, input: Pick<TodoColumn, "name" | "position">) =>
  call<TodoColumn>(base, "/api/board/columns", json("POST", input));

export const updateColumn = (base: string, id: string, patch: Partial<Pick<TodoColumn, "name" | "position">>) =>
  call<TodoColumn>(base, `/api/board/columns/${enc(id)}`, json("PATCH", patch));

/** Returns the tasks that went with it, so their calendar events can be removed. */
export const deleteColumn = (base: string, id: string) =>
  call<{ todos: Todo[] }>(base, `/api/board/columns/${enc(id)}`, { method: "DELETE" });

export const createTodo = (base: string, input: TodoPatch & Pick<Todo, "columnId" | "title" | "position">) =>
  call<Todo>(base, "/api/board/todos", json("POST", input));

export const updateTodo = (base: string, id: string, patch: TodoPatch) =>
  call<Todo>(base, `/api/board/todos/${enc(id)}`, json("PATCH", patch));

export const deleteTodo = (base: string, id: string) =>
  call<{ ok: true }>(base, `/api/board/todos/${enc(id)}`, { method: "DELETE" });

/** Demo mode (?demo, dev only): the board lives in memory, like the server would keep it. */
const demo: { columns: TodoColumn[]; todos: Todo[] } = { columns: [], todos: [] };
function demoBoard(path: string, init: RequestInit): unknown {
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body as string) : {};
  const [, , , kind, id] = path.split("/"); // "", "api", "board", kind, id
  const now = new Date().toISOString();
  if (!kind) return structuredClone(demo);
  if (kind === "columns") {
    if (method === "POST") return demo.columns[demo.columns.push({ id: crypto.randomUUID(), ...body }) - 1];
    if (method === "PATCH") return Object.assign(demo.columns.find((c) => c.id === id)!, body);
    const todos = demo.todos.filter((x) => x.columnId === id);
    demo.columns = demo.columns.filter((c) => c.id !== id);
    demo.todos = demo.todos.filter((x) => x.columnId !== id);
    return { todos };
  }
  if (method === "POST") {
    const todo: Todo = { id: crypto.randomUUID(), notes: "", dueDate: null, dueTime: null, calendarId: null, eventId: null, createdAt: now, updatedAt: now, ...body };
    demo.todos.push(todo);
    return todo;
  }
  if (method === "PATCH") return Object.assign(demo.todos.find((x) => x.id === id)!, body, { updatedAt: now });
  demo.todos = demo.todos.filter((x) => x.id !== id);
  return { ok: true };
}
