// Tasks board: columns and tasks live on the server (SQLite); a task with a deadline also gets a
// Google event on the default calendar, tagged with the task's id, so the calendar shows it.
// The board is the source of truth for the event, except that moving or deleting the event on the
// calendar moves or clears the deadline.

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./server";
import type { Todo, TodoColumn, TodoPatch } from "./server";
import { deleteEventById, eventTimes, saveEventById, type CalEvent, type Calendar, type EventInput } from "./google";
import { addDays, addMinutes, fromDateAndTime, parseDateOnly, toDateOnly, toTimeOnly } from "./dates";
import type { Translate } from "./i18n";

export type { Todo, TodoColumn };

export interface Board {
  columns: TodoColumn[];
  todos: Todo[];
}

/** A deadline at a set time shows on the calendar as a block this long. */
const DEADLINE_MINUTES = 30;

/** Last item, or undefined. */
export const lastOf = <T,>(items: T[]): T | undefined => items[items.length - 1];

export const byPosition = <T extends { position: number }>(items: T[]): T[] => [...items].sort((a, b) => a.position - b.position);

/** A position that sorts between two neighbours (either may be missing). */
export function positionBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/** The last column is the "done" one. */
export function isDone(board: Board, todo: Todo): boolean {
  const last = lastOf(byPosition(board.columns));
  return !!last && todo.columnId === last.id;
}

export function dueAt(todo: Todo): Date | null {
  if (!todo.dueDate) return null;
  return todo.dueTime ? fromDateAndTime(todo.dueDate, todo.dueTime) : parseDateOnly(todo.dueDate);
}

export function isOverdue(todo: Todo, done: boolean, now: Date): boolean {
  const due = dueAt(todo);
  if (!due || done) return false;
  return todo.dueTime ? due < now : addDays(due, 1) <= now;
}

/** Key of the calendar event linked to a task, as used by the calendar's event cache. */
export const eventKeyOf = (todo: Pick<Todo, "calendarId" | "eventId">): string | null =>
  todo.calendarId && todo.eventId ? `${todo.calendarId}/${todo.eventId}` : null;

function eventInput(todo: Todo, done: boolean): EventInput {
  const start = dueAt(todo)!;
  const end = todo.dueTime ? addMinutes(start, DEADLINE_MINUTES) : addDays(start, 1);
  return {
    summary: done ? `✓ ${todo.title}` : todo.title,
    description: todo.notes,
    ...eventTimes(start, end, !todo.dueTime),
    // A deadline isn't time you're busy.
    transparency: "transparent",
    extendedProperties: { private: { todoId: todo.id } },
  };
}

interface Options {
  /** Server base URL; empty when no server is configured. */
  base: string;
  /** Load the board (the tasks view is open). */
  active: boolean;
  calendars: Calendar[];
  defaultCalendar?: Calendar;
  t: Translate;
  onError: (e: unknown) => void;
  /** Reflects a deadline event's change on the calendar right away. */
  onEventChange: (removeKey: string | null, ev: CalEvent | null) => void;
}

export function useBoard(options: Options) {
  const { base, active } = options;
  const opts = useRef(options);
  opts.current = options;

  const [board, setBoardState] = useState<Board | null>(null);
  // Async work reads the latest board from here, not from a stale render.
  const boardRef = useRef<Board | null>(null);
  const setBoard = useCallback((next: Board | null | ((b: Board) => Board)) => {
    boardRef.current = typeof next === "function" ? (boardRef.current ? next(boardRef.current) : null) : next;
    setBoardState(boardRef.current);
  }, []);

  /** Writes still on their way; a reload now would bring back what they're changing. */
  const pending = useRef(0);
  const failed = useRef(false);
  const queues = useRef(new Map<string, Promise<void>>());
  const seeded = useRef(false);

  const reload = useCallback(async () => {
    if (!base || pending.current) return;
    try {
      let next = await api.getBoard(base);
      if (!next.columns.length && !seeded.current) {
        // First visit: start with To do / Doing / Done.
        seeded.current = true;
        const { t } = opts.current;
        const columns: TodoColumn[] = [];
        for (const [i, key] of (["colTodo", "colDoing", "colDone"] as const).entries())
          columns.push(await api.createColumn(base, { name: t(key), position: i + 1 }));
        next = { ...next, columns };
      }
      if (!pending.current) setBoard(next);
    } catch (e) {
      opts.current.onError(e);
    }
  }, [base, setBoard]);

  /** Runs writes for the same key one after another. A failure reloads the board once all writes settle. */
  const run = useCallback(
    (key: string, task: () => Promise<void>) => {
      pending.current++;
      const next = (queues.current.get(key) ?? Promise.resolve())
        .then(task)
        .catch((e) => {
          failed.current = true;
          opts.current.onError(e);
        })
        .finally(() => {
          pending.current--;
          if (queues.current.get(key) === next) queues.current.delete(key);
          if (!pending.current && failed.current) {
            failed.current = false;
            void reload();
          }
        });
      queues.current.set(key, next);
    },
    [reload],
  );

  useEffect(() => {
    setBoard(null);
    seeded.current = false;
  }, [base, setBoard]);

  useEffect(() => {
    if (active && base) void reload();
  }, [active, base, reload]);

  // --- Deadline events ---

  const setLink = async (id: string, calendarId: string | null, eventId: string | null) => {
    setBoard((b) => ({ ...b, todos: b.todos.map((x) => (x.id === id ? { ...x, calendarId, eventId } : x)) }));
    await api.updateTodo(base, id, { calendarId, eventId });
  };

  /** Creates, updates or deletes the task's calendar event to match the task. */
  const syncEvent = async (id: string) => {
    const b = boardRef.current;
    const todo = b?.todos.find((x) => x.id === id);
    const { calendars, defaultCalendar, onEventChange } = opts.current;
    // Without the calendar list we can't tell where the event lives; it'll catch up on the next edit.
    if (!b || !todo || !calendars.length) return;
    const linked = todo.calendarId ? calendars.find((c) => c.id === todo.calendarId) : undefined;
    const oldKey = linked ? eventKeyOf(todo) : null;

    if (!todo.dueDate) {
      if (!todo.eventId) return;
      if (linked) await deleteEventById(linked, todo.eventId);
      onEventChange(oldKey, null);
      await setLink(id, null, null);
      return;
    }

    const calendar = linked ?? defaultCalendar;
    if (!calendar) return;
    const ev = await saveEventById(calendar, linked ? todo.eventId : null, eventInput(todo, isDone(b, todo)));
    if (!ev) return;
    onEventChange(oldKey, ev);
    if (ev.event.id !== todo.eventId || calendar.id !== todo.calendarId) await setLink(id, calendar.id, ev.event.id);
  };

  /** Column changes can change which tasks count as done; update their events' ✓. */
  const resyncDone = (before: Board, after: Board) => {
    for (const todo of after.todos) {
      const old = before.todos.find((x) => x.id === todo.id);
      if (todo.dueDate && old && isDone(before, old) !== isDone(after, todo)) run(todo.id, () => syncEvent(todo.id));
    }
  };

  // --- Tasks ---

  const addTodo = async (columnId: string, title: string): Promise<Todo | null> => {
    const b = boardRef.current;
    if (!b || !title.trim()) return null;
    const last = lastOf(byPosition(b.todos.filter((x) => x.columnId === columnId)));
    try {
      const todo = await api.createTodo(base, { columnId, title: title.trim(), position: positionBetween(last?.position) });
      setBoard((b) => ({ ...b, todos: [...b.todos, todo] }));
      return todo;
    } catch (e) {
      opts.current.onError(e);
      return null;
    }
  };

  const updateTodo = (id: string, patch: TodoPatch) => {
    const before = boardRef.current;
    const old = before?.todos.find((x) => x.id === id);
    if (!before || !old) return;
    const full: TodoPatch = patch.dueDate === null ? { ...patch, dueTime: null } : patch;
    setBoard((b) => ({ ...b, todos: b.todos.map((x) => (x.id === id ? { ...x, ...full } : x)) }));
    const after = boardRef.current!;
    const changed = after.todos.find((x) => x.id === id)!;
    const touchesEvent =
      ["title", "notes", "dueDate", "dueTime"].some((k) => k in full) || isDone(before, old) !== isDone(after, changed);
    run(id, async () => {
      await api.updateTodo(base, id, full);
      if (touchesEvent) await syncEvent(id);
    });
  };

  const moveTodo = (id: string, columnId: string, position: number) => updateTodo(id, { columnId, position });

  const deleteTodo = (id: string) => {
    const todo = boardRef.current?.todos.find((x) => x.id === id);
    if (!todo) return;
    setBoard((b) => ({ ...b, todos: b.todos.filter((x) => x.id !== id) }));
    run(id, async () => {
      await api.deleteTodo(base, id);
      await deleteTodoEvent(todo);
    });
  };

  const deleteTodoEvent = async (todo: Todo) => {
    const calendar = opts.current.calendars.find((c) => c.id === todo.calendarId);
    if (!calendar || !todo.eventId) return;
    await deleteEventById(calendar, todo.eventId);
    opts.current.onEventChange(eventKeyOf(todo), null);
  };

  // --- Columns ---

  const addColumn = async (name: string) => {
    const b = boardRef.current;
    if (!b || !name.trim()) return;
    // New columns go before the last one, so "Done" stays the done column.
    const cols = byPosition(b.columns);
    const position = cols.length >= 2 ? positionBetween(cols[cols.length - 2].position, cols[cols.length - 1].position) : positionBetween(lastOf(cols)?.position);
    try {
      const column = await api.createColumn(base, { name: name.trim(), position });
      setBoard((b) => ({ ...b, columns: [...b.columns, column] }));
      resyncDone(b, boardRef.current!);
    } catch (e) {
      opts.current.onError(e);
    }
  };

  const renameColumn = (id: string, name: string) => {
    if (!name.trim()) return;
    setBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.id === id ? { ...c, name: name.trim() } : c)) }));
    run(`column:${id}`, async () => void (await api.updateColumn(base, id, { name: name.trim() })));
  };

  const moveColumn = (id: string, dir: -1 | 1) => {
    const before = boardRef.current;
    if (!before) return;
    const cols = byPosition(before.columns);
    const i = cols.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cols.length) return;
    // Land just past the neighbour in that direction.
    const position = dir === 1 ? positionBetween(cols[j].position, cols[j + 1]?.position) : positionBetween(cols[j - 1]?.position, cols[j].position);
    setBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.id === id ? { ...c, position } : c)) }));
    run(`column:${id}`, async () => void (await api.updateColumn(base, id, { position })));
    resyncDone(before, boardRef.current!);
  };

  const deleteColumn = (id: string) => {
    const before = boardRef.current;
    if (!before) return;
    setBoard((b) => ({ columns: b.columns.filter((c) => c.id !== id), todos: b.todos.filter((x) => x.columnId !== id) }));
    run(`column:${id}`, async () => {
      const { todos } = await api.deleteColumn(base, id);
      for (const todo of todos) await deleteTodoEvent(todo);
    });
    resyncDone(before, boardRef.current!);
  };

  // --- Changes made on the calendar ---

  /** The deadline event was moved on the calendar: the deadline follows. */
  const followEvent = (todoId: string, ev: CalEvent) => {
    const patch: TodoPatch = { dueDate: toDateOnly(ev.start), dueTime: ev.allDay ? null : toTimeOnly(ev.start) };
    setBoard((b) => ({ ...b, todos: b.todos.map((x) => (x.id === todoId ? { ...x, ...patch } : x)) }));
    if (base) run(todoId, async () => void (await api.updateTodo(base, todoId, patch)));
  };

  /** The deadline event was deleted on the calendar: so is the deadline. */
  const clearDeadline = (todoId: string) => {
    const patch: TodoPatch = { dueDate: null, dueTime: null, calendarId: null, eventId: null };
    setBoard((b) => ({ ...b, todos: b.todos.map((x) => (x.id === todoId ? { ...x, ...patch } : x)) }));
    if (base) run(todoId, async () => void (await api.updateTodo(base, todoId, patch)));
  };

  return {
    board,
    reload,
    addTodo,
    updateTodo,
    moveTodo,
    deleteTodo,
    addColumn,
    renameColumn,
    moveColumn,
    deleteColumn,
    followEvent,
    clearDeadline,
  };
}

export type BoardApi = ReturnType<typeof useBoard>;
