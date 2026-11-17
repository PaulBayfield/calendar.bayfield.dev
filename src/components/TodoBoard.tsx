import { useRef, useState, type ReactNode } from "react";
import { byPosition, dueAt, isDone, isOverdue, positionBetween, type BoardApi, type Todo, type TodoColumn } from "../lib/board";
import { addDays, isSameDay } from "../lib/dates";
import { useSettings } from "../lib/settings";
import { Dropdown } from "./pickers";
import { WindowControls } from "./Toolbar";
import { AlignLeft, CalendarIcon, More, PanelLeft, Plus } from "./icons";

interface Props {
  api: BoardApi;
  /** A server is configured to keep the board on. */
  configured: boolean;
  now: Date;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showSidebarToggle: boolean;
  onToggleSidebar: () => void;
  showWindowControls: boolean;
}

/** Where a dragged card would land. */
interface Target {
  columnId: string;
  /** Index among the column's other cards. */
  index: number;
}

interface Drag {
  id: string;
  x: number;
  y: number;
  /** Pointer offset inside the card, so it doesn't jump under the cursor. */
  offX: number;
  offY: number;
  w: number;
  h: number;
  target: Target | null;
}

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5;

export function TodoBoard(p: Props) {
  const { t } = useSettings();
  const { board } = p.api;
  const [addingColumn, setAddingColumn] = useState(false);

  // --- Dragging cards (pointer events: HTML5 drag and drop doesn't work in the desktop webview) ---

  const press = useRef<{ id: string; x: number; y: number; el: HTMLElement } | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const justDragged = useRef(false);

  const targetAt = (x: number, y: number, dragId: string): Target | null => {
    const column = document
      .elementsFromPoint(x, y)
      .map((el) => el.closest<HTMLElement>("[data-column-id]"))
      .find(Boolean);
    if (!column) return null;
    const cards = [...column.querySelectorAll<HTMLElement>("[data-todo-id]")].filter((c) => c.dataset.todoId !== dragId);
    const index = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return { columnId: column.dataset.columnId!, index: index < 0 ? cards.length : index };
  };

  const onCardPointerDown = (e: React.PointerEvent<HTMLElement>, todo: Todo) => {
    // Touch keeps scrolling the board; the task panel's column picker moves cards there.
    if (e.button !== 0 || e.pointerType === "touch") return;
    press.current = { id: todo.id, x: e.clientX, y: e.clientY, el: e.currentTarget };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onCardPointerMove = (e: React.PointerEvent) => {
    const start = press.current;
    if (!start) return;
    let d = dragRef.current;
    if (!d) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
      const r = start.el.getBoundingClientRect();
      d = { id: start.id, x: 0, y: 0, offX: start.x - r.left, offY: start.y - r.top, w: r.width, h: r.height, target: null };
      window.getSelection()?.removeAllRanges();
    }
    setDrag({ ...d, x: e.clientX, y: e.clientY, target: targetAt(e.clientX, e.clientY, d.id) });
  };

  const onCardPointerUp = () => {
    const d = dragRef.current;
    press.current = null;
    if (!d) return;
    setDrag(null);
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false));
    if (!d.target || !board) return;
    const others = byPosition(board.todos.filter((x) => x.columnId === d.target!.columnId && x.id !== d.id));
    const before = others[d.target.index - 1];
    const after = others[d.target.index];
    const todo = board.todos.find((x) => x.id === d.id);
    if (!todo) return;
    // Dropped back where it was.
    const inPlace =
      todo.columnId === d.target.columnId &&
      (!before || before.position < todo.position) &&
      (!after || after.position > todo.position);
    if (!inPlace) p.api.moveTodo(d.id, d.target.columnId, positionBetween(before?.position, after?.position));
  };

  const cardHandlers = (todo: Todo) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => onCardPointerDown(e, todo),
    onPointerMove: onCardPointerMove,
    onPointerUp: onCardPointerUp,
    onPointerCancel: () => {
      press.current = null;
      setDrag(null);
    },
    onClick: () => !justDragged.current && p.onSelect(todo.id),
  });

  const columns = board ? byPosition(board.columns) : [];
  const dragged = drag && board?.todos.find((x) => x.id === drag.id);

  return (
    <>
      <header className="toolbar" data-tauri-drag-region>
        {p.showSidebarToggle && (
          <button className="icon-button" title={`${t("toggleSidebar")} (Ctrl+B)`} onClick={p.onToggleSidebar}>
            <PanelLeft />
          </button>
        )}
        <h1 className="toolbar-title" data-tauri-drag-region>
          {t("tasks")}
        </h1>
        <div className="toolbar-spacer" data-tauri-drag-region />
        {board && (
          <button className="text-button" onClick={() => setAddingColumn(true)}>
            <Plus size={14} /> {t("newColumn")}
          </button>
        )}
        {p.showWindowControls && <WindowControls />}
      </header>
      {!p.configured ? (
        <div className="board-empty">
          <p className="muted">{t("serverNotConfigured")}</p>
        </div>
      ) : !board ? (
        <div className="board-empty">
          <span className="spinner" aria-label="Loading" />
        </div>
      ) : (
        <div className={`board${drag ? " dragging" : ""}`} onClick={(e) => e.target === e.currentTarget && p.onSelect(null)}>
          {columns.map((column, i) => (
            <Column
              key={column.id}
              column={column}
              todos={byPosition(board.todos.filter((x) => x.columnId === column.id))}
              first={i === 0}
              last={i === columns.length - 1}
              done={i === columns.length - 1 && columns.length > 1}
              api={p.api}
              now={p.now}
              selectedId={p.selectedId}
              drag={drag}
              cardHandlers={cardHandlers}
              onSelect={p.onSelect}
            />
          ))}
          {addingColumn && (
            <div className="board-column board-column-new">
              <InlineInput
                placeholder={t("columnName")}
                onSubmit={(name) => {
                  void p.api.addColumn(name);
                  setAddingColumn(false);
                }}
                onCancel={() => setAddingColumn(false)}
              />
            </div>
          )}
        </div>
      )}
      {drag && dragged && (
        <div className="board-card ghost" style={{ left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.w }}>
          <CardContent todo={dragged} done={isDone(board!, dragged)} now={p.now} />
        </div>
      )}
    </>
  );
}

interface ColumnProps {
  column: TodoColumn;
  todos: Todo[];
  first: boolean;
  last: boolean;
  done: boolean;
  api: BoardApi;
  now: Date;
  selectedId: string | null;
  drag: Drag | null;
  cardHandlers: (todo: Todo) => object;
  onSelect: (id: string) => void;
}

function Column({ column, todos, first, last, done, api, now, selectedId, drag, cardHandlers, onSelect }: ColumnProps) {
  const { t } = useSettings();
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setMenuOpen(false);
    setConfirmDelete(false);
  };

  // While dragging, the dragged card leaves its slot and a gap opens where it would land.
  const shown = drag ? todos.filter((x) => x.id !== drag.id) : todos;
  const dropIndex = drag?.target?.columnId === column.id ? drag.target.index : -1;
  const gap = drag && <div key="drop" className="board-drop" style={{ height: drag.h }} />;
  const cards: ReactNode[] = shown.map((todo) => (
    <div
      key={todo.id}
      data-todo-id={todo.id}
      role="button"
      tabIndex={0}
      className={`board-card${todo.id === selectedId ? " selected" : ""}`}
      onKeyDown={(e) => e.key === "Enter" && onSelect(todo.id)}
      {...cardHandlers(todo)}
    >
      <CardContent todo={todo} done={done} now={now} />
    </div>
  ));
  if (dropIndex >= 0) cards.splice(dropIndex, 0, gap);

  return (
    <section className={`board-column${dropIndex >= 0 ? " drop-target" : ""}`} data-column-id={column.id}>
      <div className="board-column-head">
        {renaming ? (
          <InlineInput
            initial={column.name}
            placeholder={t("columnName")}
            onSubmit={(name) => {
              if (name !== column.name) api.renameColumn(column.id, name);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <span className="board-column-name" onDoubleClick={() => setRenaming(true)}>
              {column.name}
            </span>
            <span className="board-column-count">{todos.length}</span>
            <div className="toolbar-spacer" />
            <button className="icon-button small" title={t("addTask")} onClick={() => setAdding(true)}>
              <Plus size={14} />
            </button>
            <button ref={menuAnchor} className="icon-button small" aria-label={t("column")} onClick={() => setMenuOpen((o) => !o)}>
              <More size={14} />
            </button>
          </>
        )}
        {menuOpen && (
          <Dropdown anchor={menuAnchor} onClose={closeMenu} className="board-menu">
            <button
              onClick={() => {
                closeMenu();
                setRenaming(true);
              }}
            >
              {t("rename")}
            </button>
            {!first && (
              <button
                onClick={() => {
                  closeMenu();
                  api.moveColumn(column.id, -1);
                }}
              >
                {t("moveLeft")}
              </button>
            )}
            {!last && (
              <button
                onClick={() => {
                  closeMenu();
                  api.moveColumn(column.id, 1);
                }}
              >
                {t("moveRight")}
              </button>
            )}
            <button
              className="danger"
              onClick={() => {
                if (todos.length && !confirmDelete) return setConfirmDelete(true);
                closeMenu();
                api.deleteColumn(column.id);
              }}
            >
              {confirmDelete ? t("deleteColumnTasks", { n: todos.length }) : t("deleteColumn")}
            </button>
          </Dropdown>
        )}
      </div>
      <div className="board-cards">
        {cards}
        {adding ? (
          <InlineInput
            multiline
            keepOpen
            placeholder={t("taskTitle")}
            onSubmit={(title) => void api.addTodo(column.id, title)}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button className="board-add" onClick={() => setAdding(true)}>
            <Plus size={14} /> {t("addTask")}
          </button>
        )}
      </div>
    </section>
  );
}

function CardContent({ todo, done, now }: { todo: Todo; done: boolean; now: Date }) {
  const { t, f } = useSettings();
  const due = dueAt(todo);
  const dueLabel = (d: Date) => {
    const day = isSameDay(d, now) ? t("today") : isSameDay(d, addDays(now, 1)) ? t("tomorrow") : f.shortDate(d);
    return todo.dueTime ? `${day} · ${f.time(d)}` : day;
  };
  const overdue = isOverdue(todo, done, now);
  return (
    <>
      <div className={`board-card-title${done ? " done" : ""}`}>{todo.title}</div>
      {(due || todo.notes) && (
        <div className="board-card-meta">
          {due && (
            <span className={`due-chip${overdue ? " overdue" : ""}`} title={overdue ? t("overdue") : t("deadline")}>
              <CalendarIcon size={12} />
              {dueLabel(due)}
            </span>
          )}
          {todo.notes && (
            <span className="board-card-notes" title={t("notes")}>
              <AlignLeft size={12} />
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** A text field that submits on Enter and cancels on Escape (or when left empty). */
function InlineInput({
  initial = "",
  placeholder,
  multiline,
  keepOpen,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder: string;
  multiline?: boolean;
  /** Stay open and empty after submitting, to type the next one. */
  keepOpen?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  // Removing the focused field can fire blur after Enter already submitted.
  const closed = useRef(false);
  const close = (save: boolean) => {
    if (closed.current) return;
    if (save && value.trim()) onSubmit(value.trim());
    if (save && value.trim() && keepOpen) return setValue("");
    closed.current = true;
    onCancel();
  };
  const props = {
    autoFocus: true,
    className: "board-input",
    placeholder,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => e.target.select(),
    // Clicking away keeps what was typed.
    onBlur: () => {
      if (value.trim() && keepOpen) onSubmit(value.trim());
      close(!keepOpen);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        close(true);
      } else if (e.key === "Escape") {
        e.stopPropagation();
        close(false);
      }
    },
  };
  return multiline ? <textarea rows={2} {...props} /> : <input {...props} />;
}
