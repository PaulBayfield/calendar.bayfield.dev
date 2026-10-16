// Place suggestions for the location field.
//  - Google Places (same addresses Google Maps / Waze understand), when VITE_GOOGLE_MAPS_API_KEY is set.
//  - Otherwise Photon, a free OpenStreetMap-based search (photon.komoot.io).
//  - Plus places from your own events, which are always offered first.

import type { CalEvent } from "./google";

export interface Place {
  /** What goes into the event's location field. */
  value: string;
  main: string;
  secondary?: string;
  /** Came from one of your own events. */
  recent?: boolean;
  /** [lon, lat] when known (OpenStreetMap results). */
  coords?: [number, number];
}

const BIAS_KEY = "calendar.placeBias";

/** Remember where the last picked place was, so OpenStreetMap prefers results near it. */
export function rememberPlace(place: Place) {
  if (!place.coords) return;
  try {
    localStorage.setItem(BIAS_KEY, JSON.stringify(place.coords));
  } catch {
    // Not critical.
  }
}

function placeBias(): [number, number] | null {
  try {
    return JSON.parse(localStorage.getItem(BIAS_KEY) ?? "null");
  } catch {
    return null;
  }
}

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

/** Google bills autocomplete per session: one token from the first keystroke until a place is picked. */
let sessionToken: string | null = null;
export function endPlaceSession() {
  sessionToken = null;
}

function recentPlaces(events: CalEvent[], q: string): Place[] {
  const counts = new Map<string, number>();
  for (const ev of events) {
    const loc = ev.event.location?.trim();
    if (loc && !/^https?:\/\//.test(loc)) counts.set(loc, (counts.get(loc) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([loc]) => loc.toLowerCase().includes(q))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([loc]) => {
      const [main, ...rest] = loc.split(",");
      return { value: loc, main: main.trim(), secondary: rest.join(",").trim() || undefined, recent: true };
    });
}

async function googlePlaces(input: string, lang: string): Promise<Place[]> {
  sessionToken ??= crypto.randomUUID();
  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_KEY! },
    body: JSON.stringify({ input, sessionToken, languageCode: lang }),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as {
    suggestions?: {
      placePrediction?: {
        text?: { text: string };
        structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
      };
    }[];
  };
  return (body.suggestions ?? []).flatMap(({ placePrediction: p }) =>
    p?.text
      ? [{ value: p.text.text, main: p.structuredFormat?.mainText?.text ?? p.text.text, secondary: p.structuredFormat?.secondaryText?.text }]
      : [],
  );
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties: {
    name?: string;
    housenumber?: string;
    street?: string;
    postcode?: string;
    city?: string;
    country?: string;
  };
}

async function photon(input: string, lang: string): Promise<Place[]> {
  const params = new URLSearchParams({ q: input, limit: "6", lang: ["fr", "en", "de"].includes(lang) ? lang : "en" });
  const bias = placeBias();
  if (bias) {
    params.set("lon", String(bias[0]));
    params.set("lat", String(bias[1]));
  }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { features?: PhotonFeature[] };
  return (body.features ?? []).map(({ properties: p, geometry }) => {
    const street = [p.housenumber, p.street].filter(Boolean).join(" ");
    const town = [p.postcode, p.city].filter(Boolean).join(" ");
    const main = p.name || street || town;
    const secondary = [p.name ? street : "", town, p.country].filter(Boolean).join(", ");
    return { value: [main, secondary].filter(Boolean).join(", "), main, secondary, coords: geometry?.coordinates };
  });
}

export async function suggestPlaces(query: string, events: CalEvent[], lang: string): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const recent = recentPlaces(events, q.toLowerCase());
  let remote: Place[] = [];
  try {
    remote = MAPS_KEY ? await googlePlaces(q, lang) : await photon(q, lang);
  } catch {
    // Offline or blocked: recent places only.
  }
  const seen = new Set(recent.map((p) => p.value.toLowerCase()));
  return [...recent, ...remote.filter((p) => !seen.has(p.value.toLowerCase()))].slice(0, 7);
}
