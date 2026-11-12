// Daily weather for one city, from the datawarehouse via the calendar server (which holds the API key).

import { useEffect, useMemo, useState } from "react";
import { getWeather, serverBase, type WeatherCity, type WeatherCurrent, type WeatherDay } from "./server";
import { useSettings } from "./settings";
import { demoWeather, isDemo } from "./demo";

export type { WeatherCity, WeatherCurrent, WeatherDay };

export type WeatherKind = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

/** WMO weather interpretation codes (as used by Open-Meteo) grouped into what we draw. */
export function weatherKind(code: number | null): WeatherKind | null {
  if (code === null) return null;
  if (code === 0) return "clear";
  if (code <= 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return null;
}

const REFRESH_MS = 30 * 60_000;

/** One request per server + city, shared by every caller (the day headers and the settings page). */
let cached: { key: string; at: number; promise: Promise<WeatherCity> } | null = null;

function load(base: string, city: string, force = false): Promise<WeatherCity> {
  const key = `${base}|${city.toLowerCase()}`;
  if (!force && cached && cached.key === key && cached.at + REFRESH_MS > Date.now()) return cached.promise;
  const promise = isDemo ? Promise.resolve(demoWeather(city)) : getWeather(base, city);
  cached = { key, at: Date.now(), promise };
  promise.catch(() => cached?.promise === promise && (cached = null));
  return promise;
}

export interface WeatherState {
  data: WeatherCity | null;
  error?: string;
}

/** The chosen city's weather while `enabled`, refreshed every half hour. */
export function useWeatherData(enabled: boolean): WeatherState {
  const { settings } = useSettings();
  const base = serverBase(settings.serverUrl);
  const city = settings.weatherCity;
  const [state, setState] = useState<WeatherState>({ data: null });

  useEffect(() => {
    if (!enabled || !base) return setState({ data: null });
    let live = true;
    const run = (force = false) =>
      load(base, city, force).then(
        (data) => live && setState({ data }),
        (e: Error) => live && setState((s) => ({ data: s.data, error: e.message })),
      );
    void run();
    const timer = setInterval(() => void run(true), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled, base, city]);

  return enabled && base ? state : { data: null };
}

export interface Weather {
  city: string;
  current: WeatherCurrent | null;
  /** Keyed by "YYYY-MM-DD". */
  days: Map<string, WeatherDay>;
}

/** Weather for the day headers, or null when it's off or not loaded. */
export function useWeather(): Weather | null {
  const { settings } = useSettings();
  const { data } = useWeatherData(settings.weather);
  return useMemo(
    () => (data ? { city: data.city, current: data.current, days: new Map(data.days.map((d) => [d.date, d])) } : null),
    [data],
  );
}
