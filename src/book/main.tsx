// Public booking page: /book/<id>. Shows the owner's open slots and books one.

import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "../styles.css";
import "./book.css";

interface PublicLink {
  title: string;
  duration: number;
  ownerName: string;
  meet: boolean;
  status: "open" | "booked";
  slots: string[];
}

interface Confirmation {
  start: string;
  end: string;
  meetLink?: string;
}

const fr = navigator.language.toLowerCase().startsWith("fr");
const s = fr
  ? {
      loading: "Chargement…",
      notFound: "Ce lien n'existe pas ou a expiré.",
      booked: "Ce créneau a déjà été réservé.",
      pick: "Choisissez un créneau",
      none: "Aucun créneau disponible pour le moment.",
      name: "Votre nom",
      email: "Votre e-mail",
      note: "Message (facultatif)",
      confirm: "Confirmer",
      back: "Retour",
      done: "C'est réservé !",
      invite: "Une invitation a été envoyée à {email}.",
      meet: "Google Meet",
      min: "min",
      tz: "Fuseau horaire : {tz}",
    }
  : {
      loading: "Loading…",
      notFound: "This link doesn't exist or has expired.",
      booked: "This meeting has already been booked.",
      pick: "Pick a time",
      none: "No times available right now.",
      name: "Your name",
      email: "Your email",
      note: "Message (optional)",
      confirm: "Confirm",
      back: "Back",
      done: "You're booked!",
      invite: "An invitation was sent to {email}.",
      meet: "Google Meet",
      min: "min",
      tz: "Time zone: {tz}",
    };

const locale = fr ? "fr-FR" : navigator.language;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayFmt = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });

const linkId = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() ?? "");

function Book() {
  const [link, setLink] = useState<PublicLink | null | "error">(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  useEffect(() => {
    fetch(`/api/public/links/${encodeURIComponent(linkId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setLink, () => setLink("error"));
  }, []);

  const byDay = useMemo(() => {
    const groups = new Map<string, string[]>();
    if (link && link !== "error")
      for (const slot of link.slots) {
        const key = new Date(slot).toDateString();
        groups.set(key, [...(groups.get(key) ?? []), slot]);
      }
    return [...groups.values()];
  }, [link]);

  const book = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/links/${encodeURIComponent(linkId)}/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: chosen, ...form }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error");
      setConfirmation(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (link === null) return <Shell><p className="muted">{s.loading}</p></Shell>;
  if (link === "error") return <Shell><p>{s.notFound}</p></Shell>;

  const header = (
    <header className="book-header">
      <span className="muted">{link.ownerName}</span>
      <h1>{link.title}</h1>
      <span className="muted small">
        {link.duration} {s.min}
        {link.meet && ` · ${s.meet}`}
      </span>
    </header>
  );

  if (confirmation) {
    return (
      <Shell>
        {header}
        <div className="book-done">
          <h2>{s.done}</h2>
          <p>
            {dayFmt.format(new Date(confirmation.start))} · {timeFmt.format(new Date(confirmation.start))} –{" "}
            {timeFmt.format(new Date(confirmation.end))}
          </p>
          {confirmation.meetLink && (
            <a href={confirmation.meetLink} target="_blank" rel="noreferrer">
              {confirmation.meetLink}
            </a>
          )}
          <p className="muted small">{s.invite.replace("{email}", form.email)}</p>
        </div>
      </Shell>
    );
  }

  if (link.status === "booked") return <Shell>{header}<p>{s.booked}</p></Shell>;

  if (chosen) {
    return (
      <Shell>
        {header}
        <form className="book-form" onSubmit={book}>
          <p className="book-chosen">
            {dayFmt.format(new Date(chosen))} · {timeFmt.format(new Date(chosen))}
          </p>
          <input required maxLength={100} placeholder={s.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input required type="email" maxLength={200} placeholder={s.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <textarea maxLength={1000} rows={3} placeholder={s.note} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          {error && <p className="error-text">{error}</p>}
          <div className="book-actions">
            <button type="button" className="text-button" onClick={() => setChosen(null)}>
              {s.back}
            </button>
            <button className="primary-button" disabled={busy}>
              {s.confirm}
            </button>
          </div>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      {header}
      <h2 className="book-pick">{s.pick}</h2>
      <p className="muted small">{s.tz.replace("{tz}", timeZone)}</p>
      {byDay.length === 0 && <p>{s.none}</p>}
      <div className="book-days">
        {byDay.map((slots) => (
          <div key={slots[0]} className="book-day">
            <div className="book-day-title">{dayFmt.format(new Date(slots[0]))}</div>
            <div className="book-slots">
              {slots.map((slot) => (
                <button key={slot} className="book-slot" onClick={() => setChosen(slot)}>
                  {timeFmt.format(new Date(slot))}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="book">
      <div className="book-card">{children}</div>
    </main>
  );
}

document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.lang = fr ? "fr" : "en";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Book />
  </React.StrictMode>,
);
