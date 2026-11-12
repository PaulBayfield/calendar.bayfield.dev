// Calendar server: hosts the web build, the public booking pages, and the scheduling API.
//
// Owner endpoints are authenticated with the Google access token the app already holds;
// Google's tokeninfo tells us whose it is, and only OWNER_EMAIL is let through.
// Booking needs to act on the owner's calendar while they're away, so the owner connects
// Google to the server once (Settings → Scheduling server) and the refresh token lives in SQLite.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { openStore, type Link, type Slot } from "./db.ts";
import {
  authUrl,
  calendarApi,
  exchangeCode,
  freeBusy,
  GoogleError,
  refreshAccessToken,
  tokenInfo,
  type Interval,
  type OAuthConfig,
} from "./google.ts";

// --- Config ---

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see server/.env.example)`);
  return value;
}

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = required("PUBLIC_URL").replace(/\/+$/, "");
const OWNER_EMAIL = required("OWNER_EMAIL").toLowerCase();
const OWNER_NAME = process.env.OWNER_NAME ?? OWNER_EMAIL;
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const DIST_DIR = resolve(process.env.DIST_DIR ?? resolve(import.meta.dirname, "../../dist"));
const oauth: OAuthConfig = {
  clientId: required("GOOGLE_CLIENT_ID"),
  clientSecret: required("GOOGLE_CLIENT_SECRET"),
  redirectUri: `${PUBLIC_URL}/api/google/callback`,
};
// Access tokens from either app build may call owner endpoints.
const ALLOWED_CLIENTS = new Set([oauth.clientId, ...(process.env.GOOGLE_DESKTOP_CLIENT_ID ?? "").split(",")].filter(Boolean));
const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ?? "http://localhost:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost")
    .split(",")
    .map((o) => o.trim())
    .concat(PUBLIC_URL),
);

/**
 * Header your reverse proxy puts the visitor's IP in (e.g. "cf-connecting-ip" behind a Cloudflare
 * Tunnel, or "x-forwarded-for"). Unset: the TCP peer address. Only set it when the port isn't
 * reachable except through that proxy, or the header can be forged.
 */
const CLIENT_IP_HEADER = process.env.CLIENT_IP_HEADER?.toLowerCase();

/** Datawarehouse that serves daily weather per city; the key stays here, never in the app bundle. */
const DW_API_URL = (process.env.DW_API_URL ?? "https://dash.bayfield.dev").replace(/\/+$/, "");
const DW_API_KEY = process.env.DW_API_KEY ?? "";

const MIN_NOTICE_MS = 15 * 60_000;
const store = openStore(DATA_DIR);

// --- Google access as the owner ---

const REFRESH_TOKEN_KEY = "google_refresh_token";
let ownerToken: { value: string; expiresAt: number } | null = null;

class NotConnectedError extends Error {}

async function ownerAccessToken(): Promise<string> {
  if (ownerToken && ownerToken.expiresAt - 60_000 > Date.now()) return ownerToken.value;
  const refreshToken = store.get(REFRESH_TOKEN_KEY);
  if (!refreshToken) throw new NotConnectedError("Google isn't connected to the scheduling server");
  try {
    const token = await refreshAccessToken(oauth, refreshToken);
    ownerToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  } catch (e) {
    if (e instanceof GoogleError && e.code === "invalid_grant") {
      store.delete(REFRESH_TOKEN_KEY);
      throw new NotConnectedError("Google access was revoked; reconnect it in Settings");
    }
    throw e;
  }
}

// --- Slots ---

/** Bookable start times: the link's windows cut into steps, minus anything busy. */
async function availableStarts(link: Link): Promise<string[]> {
  const now = Date.now() + MIN_NOTICE_MS;
  const windows = link.slots
    .map((s) => ({ start: Date.parse(s.start), end: Date.parse(s.end) }))
    .filter((w) => w.end > now);
  if (windows.length === 0) return [];

  const timeMin = new Date(Math.max(now, Math.min(...windows.map((w) => w.start))));
  const timeMax = new Date(Math.max(...windows.map((w) => w.end)));
  const calendars = [...new Set([link.calendarId, ...link.busyCalendarIds])];
  const busy: Interval[] = await freeBusy(await ownerAccessToken(), calendars, timeMin, timeMax);
  for (const b of store.bookingsFor(link.id)) busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });

  const duration = link.duration * 60_000;
  const step = Math.min(link.duration, 30) * 60_000;
  const starts = new Set<number>();
  for (const w of windows)
    for (let t = w.start; t + duration <= w.end; t += step)
      if (t >= now && !busy.some((b) => b.start < t + duration && b.end > t)) starts.add(t);
  return [...starts].sort((a, b) => a - b).map((t) => new Date(t).toISOString());
}

// --- Weather ---
//
// The datawarehouse's per-city route (current conditions, 7-day forecast, daily history) is
// reshaped into one list of days. Until that route is deployed, the older "last 1000 rows"
// feed fills in, with history only.

interface WeatherDay {
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
  precipitationProbability?: number | null;
  wind?: number | null;
  gusts?: number | null;
  uv?: number | null;
  /** Local "YYYY-MM-DDTHH:MM". */
  sunrise?: string | null;
  sunset?: string | null;
}

interface WeatherCurrent {
  time: string;
  temperature: number | null;
  feels: number | null;
  humidity: number | null;
  code: number | null;
  wind: number | null;
  isDay: boolean | null;
}

interface WeatherCity {
  city: string;
  cities: string[];
  current: WeatherCurrent | null;
  days: WeatherDay[];
  updatedAt: string | null;
}

const WEATHER_TTL_MS = 30 * 60_000;
const WEATHER_HISTORY_DAYS = 30;
const weatherCache = new Map<string, { at: number; data: WeatherCity }>();
const weatherInflight = new Map<string, Promise<WeatherCity>>();

/** Postgres NUMERIC columns can arrive as strings. */
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (typeof v === "string" ? v : null);
const dateOnly = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

async function dw(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${DW_API_URL}${path}`, { headers: { "X-API-Key": DW_API_KEY }, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

class WeatherRouteMissing extends Error {}

async function fetchCityWeather(requested: string): Promise<WeatherCity> {
  const get = (city: string) =>
    dw(`/api/services/weather/city?city=${encodeURIComponent(city)}&history_days=${WEATHER_HISTORY_DAYS}`);
  let res = requested ? await get(requested) : await dw("/api/services/weather/city");
  const cities: string[] = Array.isArray(res.body?.available_cities) ? res.body.available_cities.filter((c: unknown) => typeof c === "string") : [];
  // 400 (no city) and 404 (unknown city) both list the cities; fall back to the first one.
  if ((res.status === 400 || res.status === 404) && cities.length) res = await get(cities[0]);
  else if (res.status === 404 || res.status === 500) throw new WeatherRouteMissing(`city route answered ${res.status}`);
  if (res.status !== 200 || typeof res.body?.city !== "string") throw new Error(`Weather source answered ${res.status}`);

  const b = res.body;
  const days = new Map<string, WeatherDay>();
  for (const r of Array.isArray(b.history_daily) ? b.history_daily : []) {
    const date = dateOnly(r?.date);
    if (!date) continue;
    days.set(date, {
      date,
      forecast: false,
      max: num(r.temperature_max),
      min: num(r.temperature_min),
      precipitation: num(r.precipitation_sum),
      code: num(r.weather_code),
      wind: num(r.wind_speed_max),
    });
  }
  for (const r of Array.isArray(b.forecast_daily) ? b.forecast_daily : []) {
    const date = dateOnly(r?.date);
    if (!date) continue;
    days.set(date, {
      date,
      forecast: true,
      max: num(r.temperature_max),
      min: num(r.temperature_min),
      precipitation: num(r.precipitation_sum),
      code: num(r.weather_code),
      feelsMax: num(r.apparent_temperature_max),
      feelsMin: num(r.apparent_temperature_min),
      precipitationProbability: num(r.precipitation_probability_max),
      wind: num(r.wind_speed_max),
      gusts: num(r.wind_gusts_max),
      uv: num(r.uv_index_max),
      sunrise: str(r.sunrise),
      sunset: str(r.sunset),
    });
  }
  const cur = b.current;
  return {
    city: b.city,
    cities: cities.length ? cities : [b.city],
    current: cur
      ? {
          time: str(cur.timestamp) ?? "",
          temperature: num(cur.temperature),
          feels: num(cur.apparent_temperature),
          humidity: num(cur.humidity),
          code: num(cur.weather_code),
          wind: num(cur.wind_speed),
          isDay: typeof cur.is_day === "boolean" ? cur.is_day : null,
        }
      : null,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    updatedAt: str(b.last_updated),
  };
}

/** The older feed: daily observations for every city, last 1000 rows. */
async function fetchLegacyWeather(requested: string): Promise<WeatherCity> {
  const res = await dw("/api/services/weather/daily");
  if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`Weather source answered ${res.status}`);
  const rows: any[] = res.body.filter((r: any) => typeof r?.city === "string" && !Number.isNaN(Date.parse(r?.date)));
  const cities = [...new Set(rows.map((r) => r.city as string))].sort((a, b) => a.localeCompare(b));
  const city = cities.find((c) => c.toLowerCase() === requested.toLowerCase()) ?? cities[0] ?? requested;
  const days = new Map<string, WeatherDay>();
  for (const r of rows) {
    if (r.city !== city) continue;
    // Stamped at local midnight in UTC (23:00Z the day before for Paris); +12h lands on the right day.
    const date = new Date(Date.parse(r.date) + 12 * 60 * 60_000).toISOString().slice(0, 10);
    days.set(date, {
      date,
      forecast: false,
      max: num(r.temperature_max),
      min: num(r.temperature_min),
      precipitation: num(r.precipitation_sum),
      code: num(r.weather_code),
    });
  }
  return { city, cities, current: null, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), updatedAt: null };
}

async function cityWeather(requested: string): Promise<WeatherCity> {
  const key = requested.toLowerCase();
  const hit = weatherCache.get(key);
  if (hit && hit.at + WEATHER_TTL_MS > Date.now()) return hit.data;
  let inflight = weatherInflight.get(key);
  if (!inflight) {
    inflight = fetchCityWeather(requested)
      .catch((e) => {
        if (!(e instanceof WeatherRouteMissing)) throw e;
        console.warn(`Weather: ${e.message}; using the daily feed`);
        return fetchLegacyWeather(requested);
      })
      .then((data) => {
        if (weatherCache.size > 50) weatherCache.clear();
        weatherCache.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => weatherInflight.delete(key));
    weatherInflight.set(key, inflight);
  }
  try {
    return await inflight;
  } catch (e) {
    // Better slightly stale than nothing while the source is down.
    if (hit) return hit.data;
    throw e;
  }
}


// --- Request helpers ---

const verifiedTokens = new Map<string, number>();

async function requireOwner(c: Context, next: Next) {
  const token = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const cached = verifiedTokens.get(token);
  if (!cached || cached < Date.now()) {
    const info = await tokenInfo(token);
    const client = info?.azp ?? info?.aud ?? "";
    const verified = info?.email_verified === "true" || info?.email_verified === true;
    if (!info || !verified || info.email?.toLowerCase() !== OWNER_EMAIL) {
      return c.json({ error: "This Google account isn't the server's owner" }, 403);
    }
    if (!ALLOWED_CLIENTS.has(client)) {
      console.warn(`Owner token from unknown OAuth client ${client}; add it to GOOGLE_DESKTOP_CLIENT_ID`);
      return c.json({ error: "This app's Google client isn't allowed by the server (check GOOGLE_DESKTOP_CLIENT_ID)" }, 403);
    }
    if (verifiedTokens.size > 100) verifiedTokens.clear();
    verifiedTokens.set(token, Date.now() + Number(info.expires_in ?? 0) * 1000);
  }
  await next();
}

const hits = new Map<string, number[]>();
/** Sliding-window limit per `key` (bucket + client IP). */
function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) {
    // Forget clients that have gone quiet, so the map can't grow forever.
    for (const [k, times] of hits) if (times[times.length - 1] < now - 60 * 60_000) hits.delete(k);
  }
  return recent.length > limit;
}

function clientIp(c: Context): string {
  if (CLIENT_IP_HEADER) {
    const value = c.req.header(CLIENT_IP_HEADER);
    // X-Forwarded-For: the proxy appends the address it saw, so only the last entry is trustworthy.
    const ip = value?.split(",").at(-1)?.trim();
    if (ip) return ip;
  }
  return getConnInfo(c).remote.address ?? "unknown";
}

/** One booking at a time per link, so two people can't grab the same slot. */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => locks.get(key) === tail && locks.delete(key));
  return run;
}

const isIso = (s: unknown): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s));
const isEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const newId = () => randomBytes(9).toString("base64url");

function linkView(link: Link) {
  return {
    id: link.id,
    url: `${PUBLIC_URL}/book/${link.id}`,
    title: link.title,
    duration: link.duration,
    singleUse: link.singleUse,
    createdAt: link.createdAt,
    bookings: store.bookingsFor(link.id).map(({ id, start, end, name, email }) => ({ id, start, end, name, email })),
  };
}

// --- Routes ---

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof NotConnectedError) return c.json({ error: err.message }, 503);
  console.error(err);
  return c.json({ error: err instanceof GoogleError ? err.message : "Internal error" }, 500);
});

app.use(
  "*",
  secureHeaders({
    // Google sign-in returns through a popup that has to reach back to this window.
    crossOriginOpenerPolicy: "same-origin-allow-popups",
    // Keep the origin in Referer: referrer-restricted Google Maps keys need it.
    referrerPolicy: "strict-origin-when-cross-origin",
  }),
);
app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

app.use(
  "/api/*",
  cors({
    origin: (origin) => (CORS_ORIGINS.has(origin) ? origin : null),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    maxAge: 600,
  }),
);

app.get("/api/health", (c) => c.json({ ok: true }));

// Owner

app.get("/api/status", requireOwner, async (c) => {
  try {
    await ownerAccessToken();
    return c.json({ connected: true, email: store.get("google_email") });
  } catch (e) {
    if (e instanceof NotConnectedError) return c.json({ connected: false });
    throw e;
  }
});

app.post("/api/google/connect", requireOwner, (c) => {
  const state = newId();
  store.addState(state, 10 * 60_000);
  return c.json({ url: authUrl(oauth, state, OWNER_EMAIL) });
});

app.get("/api/google/callback", async (c) => {
  const page = (message: string, status: 200 | 400 | 403 = 200) =>
    c.html(
      `<!doctype html><meta charset=utf-8><title>Calendar</title><body style="font-family:system-ui;display:grid;place-items:center;height:90vh"><p>${message}</p>`,
      status,
    );
  const { code, state, error } = c.req.query();
  if (error) return page(`Google sign-in failed: ${error.replace(/[<>&"]/g, "")}`, 400);
  if (!code || !state || !store.takeState(state)) return page("This sign-in link has expired. Try again from Settings.", 400);

  const token = await exchangeCode(oauth, code);
  const info = await tokenInfo(token.access_token);
  if (info?.email?.toLowerCase() !== OWNER_EMAIL) return page("That Google account isn't the server's owner.", 403);
  if (!token.refresh_token) return page("Google didn't return a refresh token. Remove the app's access in your Google account and try again.", 400);

  store.set(REFRESH_TOKEN_KEY, token.refresh_token);
  store.set("google_email", info.email);
  ownerToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  return page("Scheduling server connected. You can close this tab.");
});

app.get("/api/weather", requireOwner, async (c) => {
  if (!DW_API_KEY) return c.json({ error: "Weather isn't configured on the server (DW_API_KEY)" }, 503);
  try {
    const city = (c.req.query("city") ?? "").trim().slice(0, 100);
    return c.json(await cityWeather(city));
  } catch (e) {
    console.warn("Weather fetch failed:", (e as Error).message);
    return c.json({ error: "Couldn't load the weather" }, 502);
  }
});

app.get("/api/links", requireOwner, (c) => c.json(store.listLinks().map(linkView)));

app.post("/api/links", requireOwner, async (c) => {
  const body = await c.req.json().catch(() => null);
  const slots: Slot[] = Array.isArray(body?.slots)
    ? body.slots
        .filter((s: Slot) => isIso(s?.start) && isIso(s?.end) && Date.parse(s.end) > Date.parse(s.start))
        .map((s: Slot) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }))
    : [];
  const duration = Number(body?.duration);
  if (
    typeof body?.title !== "string" ||
    body.title.length > 200 ||
    !Number.isInteger(duration) ||
    duration < 5 ||
    duration > 480 ||
    slots.length === 0 ||
    slots.length > 200 ||
    typeof body.calendarId !== "string"
  ) {
    return c.json({ error: "Invalid link" }, 400);
  }
  await ownerAccessToken(); // Fail early if Google isn't connected.

  const link: Link = {
    id: newId(),
    title: body.title.trim() || "Meeting",
    duration,
    slots,
    calendarId: body.calendarId,
    busyCalendarIds: Array.isArray(body.busyCalendarIds)
      ? body.busyCalendarIds.filter((id: unknown) => typeof id === "string").slice(0, 50)
      : [],
    meet: !!body.meet,
    singleUse: body.singleUse !== false,
    timeZone: typeof body.timeZone === "string" ? body.timeZone : "UTC",
    createdAt: new Date().toISOString(),
  };
  store.createLink(link);
  return c.json(linkView(link), 201);
});

app.delete("/api/links/:id", requireOwner, (c) => {
  store.deleteLink(c.req.param("id") ?? "");
  return c.json({ ok: true });
});

// Public

app.get("/api/public/links/:id", async (c) => {
  if (rateLimited(`view:${clientIp(c)}`, 60, 10 * 60_000)) return c.json({ error: "Too many requests, try again later" }, 429);
  const link = store.getLink(c.req.param("id"));
  if (!link) return c.json({ error: "Not found" }, 404);
  const booked = link.singleUse && store.bookingsFor(link.id).length > 0;
  return c.json({
    title: link.title,
    duration: link.duration,
    ownerName: OWNER_NAME,
    meet: link.meet,
    status: booked ? "booked" : "open",
    slots: booked ? [] : await availableStarts(link),
  });
});

app.post("/api/public/links/:id/book", async (c) => {
  if (rateLimited(`book:${clientIp(c)}`, 10, 60 * 60_000)) return c.json({ error: "Too many attempts, try again later" }, 429);
  const link = store.getLink(c.req.param("id"));
  if (!link) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 100) : "";
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 1000) : "";
  if (!name || !isEmail(body?.email) || !isIso(body?.start)) return c.json({ error: "Invalid booking" }, 400);
  const email: string = body.email.trim();
  const start = new Date(body.start).toISOString();

  return withLock(link.id, async () => {
    if (link.singleUse && store.bookingsFor(link.id).length > 0) {
      return c.json({ error: "This meeting has already been booked" }, 409);
    }
    if (!(await availableStarts(link)).includes(start)) {
      return c.json({ error: "That time is no longer available" }, 409);
    }

    const end = new Date(Date.parse(start) + link.duration * 60_000).toISOString();
    const event = await calendarApi<{ id: string; hangoutLink?: string }>(
      await ownerAccessToken(),
      `/calendars/${encodeURIComponent(link.calendarId)}/events`,
      {
        method: "POST",
        params: { sendUpdates: "all", conferenceDataVersion: "1" },
        body: {
          summary: `${link.title} (${name})`,
          description: note || undefined,
          start: { dateTime: start, timeZone: link.timeZone },
          end: { dateTime: end, timeZone: link.timeZone },
          attendees: [{ email, displayName: name }],
          ...(link.meet
            ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
            : {}),
        },
      },
    );

    store.addBooking({ id: newId(), linkId: link.id, start, end, name, email, eventId: event.id, createdAt: new Date().toISOString() });
    return c.json({ start, end, meetLink: event.hangoutLink });
  });
});

// Web app + booking pages

if (existsSync(DIST_DIR)) {
  const html = (file: string) => readFileSync(resolve(DIST_DIR, file), "utf8");
  app.get("/book/:id", (c) => c.html(html("book.html")));
  app.use("/*", serveStatic({ root: relative(process.cwd(), DIST_DIR) }));
  app.get("*", (c) => (/^\/(api|assets)\//.test(c.req.path) ? c.notFound() : c.html(html("index.html"))));
} else {
  console.warn(`No web build at ${DIST_DIR}; only the API is served. Run \`npm run build\` in the project root.`);
}

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`Calendar server on http://localhost:${port} (public URL ${PUBLIC_URL})`);
});
