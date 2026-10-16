import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Slot {
  start: string;
  end: string;
}

export interface Link {
  id: string;
  title: string;
  duration: number;
  slots: Slot[];
  calendarId: string;
  busyCalendarIds: string[];
  meet: boolean;
  singleUse: boolean;
  timeZone: string;
  createdAt: string;
}

export interface Booking {
  id: string;
  linkId: string;
  start: string;
  end: string;
  name: string;
  email: string;
  eventId: string;
  createdAt: string;
}

interface LinkRow {
  id: string;
  title: string;
  duration: number;
  slots: string;
  calendar_id: string;
  busy_calendar_ids: string;
  meet: number;
  single_use: number;
  time_zone: string;
  created_at: string;
}

interface BookingRow {
  id: string;
  link_id: string;
  start: string;
  end: string;
  name: string;
  email: string;
  event_id: string;
  created_at: string;
}

export type Store = ReturnType<typeof openStore>;

export function openStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "calendar.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      duration INTEGER NOT NULL,
      slots TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      busy_calendar_ids TEXT NOT NULL,
      meet INTEGER NOT NULL,
      single_use INTEGER NOT NULL,
      time_zone TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookings_link ON bookings(link_id);
  `);

  const toLink = (r: LinkRow): Link => ({
    id: r.id,
    title: r.title,
    duration: r.duration,
    slots: JSON.parse(r.slots),
    calendarId: r.calendar_id,
    busyCalendarIds: JSON.parse(r.busy_calendar_ids),
    meet: !!r.meet,
    singleUse: !!r.single_use,
    timeZone: r.time_zone,
    createdAt: r.created_at,
  });

  const toBooking = (r: BookingRow): Booking => ({
    id: r.id,
    linkId: r.link_id,
    start: r.start,
    end: r.end,
    name: r.name,
    email: r.email,
    eventId: r.event_id,
    createdAt: r.created_at,
  });

  return {
    get(key: string): string | undefined {
      return (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
    },
    set(key: string, value: string) {
      db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
    delete(key: string) {
      db.prepare("DELETE FROM kv WHERE key = ?").run(key);
    },

    addState(state: string, ttlMs: number) {
      db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(Date.now());
      db.prepare("INSERT INTO oauth_states (state, expires_at) VALUES (?, ?)").run(state, Date.now() + ttlMs);
    },
    /** Single use: returns true and deletes the state if it was valid. */
    takeState(state: string): boolean {
      const res = db.prepare("DELETE FROM oauth_states WHERE state = ? AND expires_at >= ?").run(state, Date.now());
      return Number(res.changes) > 0;
    },

    createLink(link: Link) {
      db.prepare(
        `INSERT INTO links (id, title, duration, slots, calendar_id, busy_calendar_ids, meet, single_use, time_zone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        link.id,
        link.title,
        link.duration,
        JSON.stringify(link.slots),
        link.calendarId,
        JSON.stringify(link.busyCalendarIds),
        link.meet ? 1 : 0,
        link.singleUse ? 1 : 0,
        link.timeZone,
        link.createdAt,
      );
    },
    getLink(id: string): Link | undefined {
      const row = db.prepare("SELECT * FROM links WHERE id = ?").get(id) as LinkRow | undefined;
      return row && toLink(row);
    },
    listLinks(): Link[] {
      return (db.prepare("SELECT * FROM links ORDER BY created_at DESC").all() as unknown as LinkRow[]).map(toLink);
    },
    deleteLink(id: string) {
      db.prepare("DELETE FROM bookings WHERE link_id = ?").run(id);
      db.prepare("DELETE FROM links WHERE id = ?").run(id);
    },

    addBooking(b: Booking) {
      db.prepare(
        "INSERT INTO bookings (id, link_id, start, end, name, email, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(b.id, b.linkId, b.start, b.end, b.name, b.email, b.eventId, b.createdAt);
    },
    bookingsFor(linkId: string): Booking[] {
      return (db.prepare("SELECT * FROM bookings WHERE link_id = ? ORDER BY start").all(linkId) as unknown as BookingRow[]).map(toBooking);
    },
  };
}
