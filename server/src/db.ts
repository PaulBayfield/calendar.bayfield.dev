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

/** A kanban column. Ordered by `position` (fractional, so a move rewrites one row). */
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
  /** Deadline day, "YYYY-MM-DD" (the owner's local day). */
  dueDate: string | null;
  /** Deadline time, "HH:MM"; null for a whole-day deadline. */
  dueTime: string | null;
  /** The Google event that shows the deadline on the calendar. */
  calendarId: string | null;
  eventId: string | null;
  /** 0 none, 1 low, 2 medium, 3 high. */
  priority: number;
  /** When the task reached the done column; done tasks can be hidden after a while. */
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TodoRow {
  id: string;
  column_id: string;
  title: string;
  notes: string;
  position: number;
  due_date: string | null;
  due_time: string | null;
  calendar_id: string | null;
  event_id: string | null;
  priority: number;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Todo fields a PATCH may change, mapped to their columns. */
const TODO_FIELDS = {
  columnId: "column_id",
  title: "title",
  notes: "notes",
  position: "position",
  dueDate: "due_date",
  dueTime: "due_time",
  calendarId: "calendar_id",
  eventId: "event_id",
  priority: "priority",
  doneAt: "done_at",
} as const;
export type TodoPatch = Partial<Pick<Todo, keyof typeof TODO_FIELDS>>;

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
    CREATE TABLE IF NOT EXISTS todo_columns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES todo_columns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      position REAL NOT NULL,
      due_date TEXT,
      due_time TEXT,
      calendar_id TEXT,
      event_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS todos_column ON todos(column_id);
  `);
  // Columns added after the todos table first shipped (0.1.14).
  const todoColumns = new Set((db.prepare("PRAGMA table_info(todos)").all() as { name: string }[]).map((c) => c.name));
  if (!todoColumns.has("priority")) db.exec("ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
  if (!todoColumns.has("done_at")) db.exec("ALTER TABLE todos ADD COLUMN done_at TEXT");

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

  const toTodo = (r: TodoRow): Todo => ({
    id: r.id,
    columnId: r.column_id,
    title: r.title,
    notes: r.notes,
    position: r.position,
    dueDate: r.due_date,
    dueTime: r.due_time,
    calendarId: r.calendar_id,
    eventId: r.event_id,
    priority: r.priority,
    doneAt: r.done_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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

    listColumns(): TodoColumn[] {
      return db.prepare("SELECT id, name, position FROM todo_columns ORDER BY position").all() as unknown as TodoColumn[];
    },
    getColumn(id: string): TodoColumn | undefined {
      return db.prepare("SELECT id, name, position FROM todo_columns WHERE id = ?").get(id) as TodoColumn | undefined;
    },
    addColumn(col: TodoColumn) {
      db.prepare("INSERT INTO todo_columns (id, name, position) VALUES (?, ?, ?)").run(col.id, col.name, col.position);
    },
    updateColumn(id: string, patch: Partial<Pick<TodoColumn, "name" | "position">>) {
      if (patch.name !== undefined) db.prepare("UPDATE todo_columns SET name = ? WHERE id = ?").run(patch.name, id);
      if (patch.position !== undefined) db.prepare("UPDATE todo_columns SET position = ? WHERE id = ?").run(patch.position, id);
    },
    /** Deletes the column and its todos; returns the todos so their calendar events can be removed. */
    deleteColumn(id: string): Todo[] {
      const removed = (db.prepare("SELECT * FROM todos WHERE column_id = ?").all(id) as unknown as TodoRow[]).map(toTodo);
      db.prepare("DELETE FROM todos WHERE column_id = ?").run(id);
      db.prepare("DELETE FROM todo_columns WHERE id = ?").run(id);
      return removed;
    },

    listTodos(): Todo[] {
      return (db.prepare("SELECT * FROM todos ORDER BY position").all() as unknown as TodoRow[]).map(toTodo);
    },
    getTodo(id: string): Todo | undefined {
      const row = db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as TodoRow | undefined;
      return row && toTodo(row);
    },
    addTodo(t: Todo) {
      db.prepare(
        `INSERT INTO todos (id, column_id, title, notes, position, due_date, due_time, calendar_id, event_id, priority, done_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(t.id, t.columnId, t.title, t.notes, t.position, t.dueDate, t.dueTime, t.calendarId, t.eventId, t.priority, t.doneAt, t.createdAt, t.updatedAt);
    },
    updateTodo(id: string, patch: TodoPatch) {
      const entries = (Object.keys(TODO_FIELDS) as (keyof typeof TODO_FIELDS)[]).flatMap((k) =>
        patch[k] === undefined ? [] : [[TODO_FIELDS[k], patch[k]] as const],
      );
      if (!entries.length) return;
      db.prepare(`UPDATE todos SET ${entries.map(([col]) => `${col} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...entries.map(([, v]) => v),
        new Date().toISOString(),
        id,
      );
    },
    deleteTodo(id: string) {
      db.prepare("DELETE FROM todos WHERE id = ?").run(id);
    },
  };
}
