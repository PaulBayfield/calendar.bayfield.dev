// Email suggestions for the guest field.
//  - People who appear in your events (no extra permission needed).
//  - Your Google contacts and "other contacts" (everyone you've emailed), via the People API.
//    That needs the contacts.readonly + contacts.other.readonly scopes; without them we quietly
//    fall back to the event-based list.

import { getAccessToken } from "./auth";
import { isDemo } from "./demo";
import type { CalEvent } from "./google";

export interface Contact {
  email: string;
  name?: string;
}

const PEOPLE = "https://people.googleapis.com/v1";
let peopleAvailable = !isDemo;
let warmedUp = false;

/** Everyone you've had in events, most frequent first. */
export function contactsFromEvents(events: CalEvent[]): Contact[] {
  const seen = new Map<string, { contact: Contact; count: number }>();
  for (const ev of events)
    for (const a of ev.event.attendees ?? []) {
      if (a.self || !a.email || a.email.endsWith("calendar.google.com")) continue;
      const key = a.email.toLowerCase();
      const entry = seen.get(key) ?? { contact: { email: a.email, name: a.displayName }, count: 0 };
      entry.count++;
      entry.contact.name ??= a.displayName;
      seen.set(key, entry);
    }
  return [...seen.values()].sort((a, b) => b.count - a.count).map((e) => e.contact);
}

async function people(path: string, query: string): Promise<Contact[]> {
  const params = new URLSearchParams({ query, readMask: "names,emailAddresses", pageSize: "10" });
  const res = await fetch(`${PEOPLE}${path}?${params}`, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  if (res.status === 401 || res.status === 403) {
    peopleAvailable = false; // Scope not granted or API not enabled: stick to local suggestions.
    return [];
  }
  if (!res.ok) return [];
  const body = (await res.json()) as {
    results?: { person?: { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[] } }[];
  };
  return (body.results ?? []).flatMap(({ person }) =>
    (person?.emailAddresses ?? []).flatMap((e) => (e.value ? [{ email: e.value, name: person?.names?.[0]?.displayName }] : [])),
  );
}

async function searchPeople(query: string): Promise<Contact[]> {
  if (!peopleAvailable) return [];
  // The People API search wants an empty "warm-up" request before real queries.
  if (!warmedUp) {
    warmedUp = true;
    await Promise.all([people("/people:searchContacts", ""), people("/otherContacts:search", "")]).catch(() => {});
  }
  const [contacts, others] = await Promise.all([
    people("/people:searchContacts", query).catch(() => []),
    people("/otherContacts:search", query).catch(() => []),
  ]);
  return [...contacts, ...others];
}

const matches = (c: Contact, q: string) => c.email.toLowerCase().includes(q) || !!c.name?.toLowerCase().includes(q);

/** Suggestions for what's typed so far, excluding people already invited. */
export async function suggestContacts(query: string, events: CalEvent[], exclude: string[]): Promise<Contact[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  const local = contactsFromEvents(events).filter((c) => matches(c, q));
  const remote = await searchPeople(q);
  const out = new Map<string, Contact>();
  for (const c of [...local, ...remote]) {
    const key = c.email.toLowerCase();
    if (!skip.has(key) && !out.has(key)) out.set(key, c);
  }
  return [...out.values()].slice(0, 8);
}
