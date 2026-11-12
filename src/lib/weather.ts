// Daily weather per city, from the datawarehouse via the calendar server (which holds the API key).

import { useEffect, useMemo, useState } from "react";
import { getWeather, serverBase, type WeatherDay } from "./server";
import { useSettings } from "./settings";

export type { WeatherDay };

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

const REFRESH_MS = 60 * 60_000;

/** One request shared by every caller (the day headers and the settings page). */
let cached: { base: string; at: number; promise: Promise<WeatherDay[]> } | null = null;

function load(base: string, force = false): Promise<WeatherDay[]> {
  if (!force && cached && cached.base === base && cached.at + REFRESH_MS > Date.now()) return cached.promise;
  const promise = getWeather(base);
  cached = { base, at: Date.now(), promise };
  promise.catch(() => cached?.promise === promise && (cached = null));
  return promise;
}

export type WeatherState = { days: WeatherDay[]; error?: undefined } | { days: null; error?: string };

/** All rows, while `enabled`; refreshed hourly. */
export function useWeatherData(enabled: boolean): WeatherState {
  const { settings } = useSettings();
  const base = serverBase(settings.serverUrl);
  const [state, setState] = useState<WeatherState>({ days: null });

  useEffect(() => {
    if (!enabled || !base) return setState({ days: null });
    let live = true;
    const run = (force = false) =>
      load(base, force).then(
        (days) => live && setState({ days }),
        (e: Error) => live && setState({ days: null, error: e.message }),
      );
    void run();
    const timer = setInterval(() => void run(true), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled, base]);

  return base || !enabled ? state : { days: null, error: undefined };
}

export function weatherCities(days: WeatherDay[]): string[] {
  return [...new Set(days.map((d) => d.city))].sort((a, b) => a.localeCompare(b));
}

/** The chosen city's days keyed by "YYYY-MM-DD", or null when weather is off. */
export function useWeather(): Map<string, WeatherDay> | null {
  const { settings } = useSettings();
  const { days } = useWeatherData(settings.weather);
  return useMemo(() => {
    if (!days) return null;
    const city = settings.weatherCity || weatherCities(days)[0];
    return new Map(days.filter((d) => d.city === city).map((d) => [d.date, d]));
  }, [days, settings.weatherCity]);
}
