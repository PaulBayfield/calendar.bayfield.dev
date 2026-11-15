// Errors float in a stack at the top right instead of pushing the page down. Each closes by
// itself after a while (not while hovered), and the same error again only bumps a count.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "../lib/settings";
import { Info, X } from "./icons";

const LIFETIME = 8000;
const MAX = 4;

export interface AppError {
  id: number;
  message: string;
  count: number;
}

/** The errors shown, and the function that adds one. */
export function useErrors() {
  const [errors, setErrors] = useState<AppError[]>([]);
  const next = useRef(0);
  const push = useCallback((message: string) => {
    setErrors((list) => {
      const same = list.find((e) => e.message === message);
      // A repeat moves to the top with a fresh id, which restarts its timer.
      if (same) return [{ ...same, id: ++next.current, count: same.count + 1 }, ...list.filter((e) => e !== same)];
      return [{ id: ++next.current, message, count: 1 }, ...list].slice(0, MAX);
    });
  }, []);
  const dismiss = useCallback((id: number) => setErrors((list) => list.filter((e) => e.id !== id)), []);
  return { errors, push, dismiss };
}

export function ErrorStack({ errors, onDismiss }: { errors: AppError[]; onDismiss: (id: number) => void }) {
  if (!errors.length) return null;
  return (
    <div className="error-stack" role="region" aria-live="assertive">
      {errors.map((e) => (
        <ErrorCard key={e.id} error={e} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ErrorCard({ error, onDismiss }: { error: AppError; onDismiss: (id: number) => void }) {
  const { t } = useSettings();
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (hovered) return;
    const timer = setTimeout(() => onDismiss(error.id), LIFETIME);
    return () => clearTimeout(timer);
  }, [hovered, onDismiss, error.id]);
  return (
    <div className="error-card" role="alert" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <span className="error-card-icon">
        <Info size={16} />
      </span>
      <span className="error-card-text">
        {error.message}
        {error.count > 1 && <span className="error-card-count">×{error.count}</span>}
      </span>
      <button className="icon-button small" title={t("dismiss")} onClick={() => onDismiss(error.id)}>
        <X size={14} />
      </button>
    </div>
  );
}
