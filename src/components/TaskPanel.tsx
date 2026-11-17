import { useState, type ReactNode } from "react";
import { byPosition, lastOf, positionBetween, PRIORITY_LABELS, type BoardApi, type Board, type Priority, type Todo } from "../lib/board";
import { toDateOnly } from "../lib/dates";
import { useSettings } from "../lib/settings";
import { PanelHeader } from "./PanelHeader";
import { DatePicker, TimePicker } from "./pickers";
import { AlignLeft, CalendarIcon, External, Flag, Kanban, Trash, X } from "./icons";

interface Props {
  todo: Todo;
  board: Board;
  api: BoardApi;
  /** Jump to the deadline's event on the calendar. */
  onShowInCalendar: (todo: Todo) => void;
  onClose: () => void;
}

/** Details of one task, in the side panel. Remount it (key) when another task is selected. */
export function TaskPanel({ todo, board, api, onShowInCalendar, onClose }: Props) {
  const { t, f } = useSettings();
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  const columns = byPosition(board.columns);

  const commitTitle = () => {
    const next = title.trim();
    if (!next) return setTitle(todo.title);
    if (next !== todo.title) api.updateTodo(todo.id, { title: next });
  };

  const moveToColumn = (columnId: string) => {
    const last = lastOf(byPosition(board.todos.filter((x) => x.columnId === columnId && x.id !== todo.id)));
    api.moveTodo(todo.id, columnId, positionBetween(last?.position));
  };

  return (
    <>
      <PanelHeader label={t("task")} onClose={onClose} />
      <div className="panel-body">
        <input
          className="panel-title-input"
          placeholder={t("taskTitle")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />

        <div className="panel-section">
          <Row icon={<Kanban />}>
            <select value={todo.columnId} aria-label={t("column")} onChange={(e) => moveToColumn(e.target.value)}>
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Row>
          <Row icon={<Flag />}>
            <select
              value={todo.priority}
              aria-label={t("priority")}
              className={`priority-select p${todo.priority}`}
              onChange={(e) => api.updateTodo(todo.id, { priority: Number(e.target.value) as Priority })}
            >
              {([3, 2, 1, 0] as const).map((p) => (
                <option key={p} value={p}>
                  {t(PRIORITY_LABELS[p])}
                </option>
              ))}
            </select>
          </Row>
          <Row icon={<CalendarIcon />}>
            {!todo.dueDate ? (
              <button className="link-button" onClick={() => api.updateTodo(todo.id, { dueDate: toDateOnly(new Date()) })}>
                {t("addDeadline")}
              </button>
            ) : (
              <div className="task-deadline">
                <DatePicker value={todo.dueDate} onChange={(dueDate) => api.updateTodo(todo.id, { dueDate })} />
                {todo.dueTime ? (
                  <>
                    <TimePicker value={todo.dueTime} onChange={(dueTime) => api.updateTodo(todo.id, { dueTime })} />
                    <button className="icon-button tiny" title={t("removeTime")} onClick={() => api.updateTodo(todo.id, { dueTime: null })}>
                      <X size={12} />
                    </button>
                  </>
                ) : (
                  <button className="link-button" onClick={() => api.updateTodo(todo.id, { dueTime: "09:00" })}>
                    {t("addTime")}
                  </button>
                )}
                <div className="toolbar-spacer" />
                <button className="icon-button small danger" title={t("removeDeadline")} onClick={() => api.updateTodo(todo.id, { dueDate: null })}>
                  <Trash size={13} />
                </button>
              </div>
            )}
          </Row>
          {todo.dueDate && (
            <Row>
              <button className="link-button with-icon" onClick={() => onShowInCalendar(todo)}>
                {t("showInCalendar")} <External size={13} />
              </button>
            </Row>
          )}
          <Row icon={<AlignLeft />}>
            <textarea
              className="ghost-input"
              placeholder={t("notesPlaceholder")}
              rows={Math.min(12, Math.max(3, notes.split("\n").length))}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => notes !== todo.notes && api.updateTodo(todo.id, { notes })}
            />
          </Row>
        </div>

        <p className="panel-note">{t("tasksHint")}</p>

        <div className="panel-footer">
          <button
            className="icon-button danger"
            title={t("delete")}
            onClick={() => {
              api.deleteTodo(todo.id);
              onClose();
            }}
          >
            <Trash />
          </button>
          <span className="muted small">{f.shortDate(new Date(todo.createdAt))}</span>
        </div>
      </div>
    </>
  );
}

function Row({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel-row">
      <span className="panel-row-icon">{icon}</span>
      <div className="panel-row-content">{children}</div>
    </div>
  );
}
