// Weather icon in a day header, and the card it opens on hover: the day's forecast or
// observations, plus a temperature chart (highs and lows) and a precipitation strip for the
// days around it. Observed days are drawn solid, forecast days dashed.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { addDays, isSameDay, parseDateOnly, toDateOnly } from "../lib/dates";
import type { StringKey } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { weatherKind, type Weather, type WeatherDay, type WeatherKind } from "../lib/weather";
import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Sun } from "./icons";

const WEATHER: Record<WeatherKind, { icon: typeof Sun; label: StringKey }> = {
  clear: { icon: Sun, label: "weatherClear" },
  partly: { icon: CloudSun, label: "weatherPartly" },
  cloudy: { icon: Cloud, label: "weatherCloudy" },
  fog: { icon: CloudFog, label: "weatherFog" },
  drizzle: { icon: CloudDrizzle, label: "weatherDrizzle" },
  rain: { icon: CloudRain, label: "weatherRain" },
  snow: { icon: CloudSnow, label: "weatherSnow" },
  storm: { icon: CloudLightning, label: "weatherStorm" },
};

/** Days either side of the hovered one in the chart. */
const SPAN = 3;
const OPEN_DELAY = 120;
const CLOSE_DELAY = 180;
const CARD_WIDTH = 300;

const deg = (n: number | null | undefined) => (n == null ? "–" : `${Math.round(n)}°`);
const mm = (n: number | null | undefined) => (n == null ? "–" : `${Math.round(n * 10) / 10} mm`);

export function WeatherIcon({ day, weather }: { day: WeatherDay; weather: Weather }) {
  const { t } = useSettings();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const kind = weatherKind(day.code);
  if (!kind) return null;
  const { icon: Icon, label } = WEATHER[kind];

  const later = (value: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(value), ms);
  };
  const hover = { onMouseEnter: () => later(true, open ? 0 : OPEN_DELAY), onMouseLeave: () => later(false, CLOSE_DELAY) };

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`day-weather ${kind}`}
        aria-label={`${t(label)}, ${deg(day.max)} / ${deg(day.min)}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => later(false, CLOSE_DELAY)}
        {...hover}
      >
        <Icon size={14} />
      </button>
      {open && ref.current && <WeatherCard anchor={ref.current} day={day} weather={weather} hover={hover} onClose={() => setOpen(false)} />}
    </>
  );
}

interface CardProps {
  anchor: HTMLElement;
  day: WeatherDay;
  weather: Weather;
  hover: { onMouseEnter: () => void; onMouseLeave: () => void };
  onClose: () => void;
}

function WeatherCard({ anchor, day, weather, hover, onClose }: CardProps) {
  const { t, f } = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 0;
    const left = Math.min(Math.max(8, a.left + a.width / 2 - CARD_WIDTH / 2), window.innerWidth - CARD_WIDTH - 8);
    const below = a.bottom + 6;
    setPos({ left, top: below + height > window.innerHeight - 8 ? Math.max(8, a.top - height - 6) : below });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const date = parseDateOnly(day.date);
  const series: { date: Date; day: WeatherDay | undefined }[] = [];
  for (let i = -SPAN; i <= SPAN; i++) {
    const d = addDays(date, i);
    series.push({ date: d, day: weather.days.get(toDateOnly(d)) });
  }
  const kind = weatherKind(day.code)!;
  const { icon: Icon, label } = WEATHER[kind];
  const now = isSameDay(date, new Date()) ? weather.current : null;
  const clock = (s: string | null | undefined) => (s ? f.time(new Date(s)) : null);

  const details: [StringKey, ReactNode][] = [];
  if (now?.temperature != null)
    details.push(["weatherNow", `${deg(now.temperature)}${now.feels != null ? ` (${t("weatherFeels").toLowerCase()} ${deg(now.feels)})` : ""}`]);
  if (day.feelsMax != null || day.feelsMin != null) details.push(["weatherFeels", `${deg(day.feelsMax)} / ${deg(day.feelsMin)}`]);
  if (day.precipitationProbability != null) details.push(["weatherRainChance", `${Math.round(day.precipitationProbability)} %`]);
  if (day.wind != null) details.push(["weatherWind", `${Math.round(day.wind)} km/h${day.gusts != null ? ` · ${Math.round(day.gusts)} max` : ""}`]);
  if (now?.humidity != null) details.push(["weatherHumidity", `${Math.round(now.humidity)} %`]);
  if (day.uv != null) details.push(["weatherUv", String(Math.round(day.uv))]);
  if (day.sunrise || day.sunset) details.push(["weatherSun", `${clock(day.sunrise) ?? "–"} / ${clock(day.sunset) ?? "–"}`]);

  return createPortal(
    <div
      ref={ref}
      className="weather-card"
      role="dialog"
      aria-label={`${t("weather")} · ${weather.city}`}
      style={{ width: CARD_WIDTH, left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      {...hover}
    >
      <header className="weather-card-head">
        <span className={`weather-card-icon ${kind}`}>
          <Icon size={28} />
        </span>
        <div className="weather-card-title">
          <strong>{t(label)}</strong>
          <span className="small muted">
            {weather.city} · {f.shortDate(date)}
          </span>
        </div>
        <span className="weather-card-badge">{t(day.forecast ? "weatherForecast" : "weatherObserved")}</span>
      </header>
      <dl className="weather-card-stats">
        <div>
          <dt>{t("weatherHigh")}</dt>
          <dd>{deg(day.max)}</dd>
        </div>
        <div>
          <dt>{t("weatherLow")}</dt>
          <dd>{deg(day.min)}</dd>
        </div>
        <div>
          <dt>{t("weatherPrecipitation")}</dt>
          <dd>{mm(day.precipitation)}</dd>
        </div>
      </dl>
      {details.length > 0 && (
        <dl className="weather-card-details">
          {details.map(([key, value]) => (
            <div key={key}>
              <dt>{t(key)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {series.filter((s) => s.day && (s.day.max !== null || s.day.min !== null)).length >= 2 && (
        <WeatherChart series={series} focus={day.date} />
      )}
    </div>,
    document.body,
  );
}

const W = CARD_WIDTH - 32;
const PAD = { top: 18, right: 8, bottom: 20, left: 8 };
const TEMP_H = 120;
const RAIN_H = 34;

function WeatherChart({ series, focus }: { series: { date: Date; day: WeatherDay | undefined }[]; focus: string }) {
  const { t, f } = useSettings();
  const [hovered, setHovered] = useState<number | null>(null);

  const temps = series.flatMap((s) => [s.day?.max, s.day?.min]).filter((v): v is number => typeof v === "number");
  let lo = Math.floor(Math.min(...temps));
  let hi = Math.ceil(Math.max(...temps));
  if (hi - lo < 6) {
    const mid = (hi + lo) / 2;
    lo = Math.floor(mid - 3);
    hi = Math.ceil(mid + 3);
  }
  const step = (W - PAD.left - PAD.right) / (series.length - 1);
  const x = (i: number) => PAD.left + i * step;
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (TEMP_H - PAD.top - PAD.bottom);

  /** Path through the days `include` accepts; a forecast run starts from the observation before it. */
  const line = (pick: (d: WeatherDay) => number | null, forecast: boolean) => {
    let d = "";
    let pen = false;
    series.forEach((s, i) => {
      const v = s.day ? pick(s.day) : null;
      if (v === null || s.day!.forecast !== forecast) {
        // Join the dashed forecast onto the last observed point.
        const next = series[i + 1]?.day;
        if (forecast && v !== null && next?.forecast && pick(next) !== null) {
          d += `M${x(i).toFixed(1)},${y(v).toFixed(1)}`;
          pen = true;
        } else pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const both = series.map((s, i) => ({ i, max: s.day?.max ?? null, min: s.day?.min ?? null })).filter((p) => p.max !== null && p.min !== null);
  const band =
    both.length >= 2
      ? `M${both.map((p) => `${x(p.i)},${y(p.max!)}`).join("L")}L${[...both]
          .reverse()
          .map((p) => `${x(p.i)},${y(p.min!)}`)
          .join("L")}Z`
      : "";

  const rains = series.map((s) => s.day?.precipitation ?? null);
  const rainMax = Math.max(1, ...rains.filter((v): v is number => v !== null));
  const focusIndex = series.findIndex((s) => toDateOnly(s.date) === focus);
  const active = hovered ?? focusIndex;
  const activeDay = series[active]?.day;
  const barW = Math.min(14, step * 0.45);
  const hasForecast = series.some((s) => s.day?.forecast);
  const hasObserved = series.some((s) => s.day && !s.day.forecast);

  return (
    <figure className="weather-chart">
      <figcaption>
        <span className="small muted">{t("weatherTemperature")}</span>
        <span className="weather-legend small">
          <span className="swatch max" />
          {t("weatherHigh")}
          <span className="swatch min" />
          {t("weatherLow")}
          {hasForecast && hasObserved && (
            <>
              <span className="swatch dashed" />
              {t("weatherForecast")}
            </>
          )}
        </span>
      </figcaption>
      <svg width={W} height={TEMP_H + RAIN_H} role="img" aria-label={t("weatherTemperature")} onMouseLeave={() => setHovered(null)}>
        {/* Recessive guides at the top and bottom of the scale. */}
        {[hi, lo].map((v) => (
          <g key={v}>
            <line className="grid" x1={0} x2={W} y1={y(v)} y2={y(v)} />
            <text className="axis" x={W} y={y(v) - 3} textAnchor="end">
              {v}°
            </text>
          </g>
        ))}
        <line className="crosshair" x1={x(active)} x2={x(active)} y1={PAD.top - 6} y2={TEMP_H + RAIN_H - 14} />
        {band && <path className="band" d={band} />}
        <path className="series max" d={line((d) => d.max, false)} />
        <path className="series min" d={line((d) => d.min, false)} />
        <path className="series max forecast" d={line((d) => d.max, true)} />
        <path className="series min forecast" d={line((d) => d.min, true)} />
        {activeDay?.max != null && (
          <>
            <circle className="dot max" cx={x(active)} cy={y(activeDay.max)} r={4} />
            <text className="value" x={x(active)} y={y(activeDay.max) - 8} textAnchor="middle">
              {deg(activeDay.max)}
            </text>
          </>
        )}
        {activeDay?.min != null && (
          <>
            <circle className="dot min" cx={x(active)} cy={y(activeDay.min)} r={4} />
            <text className="value" x={x(active)} y={y(activeDay.min) + 15} textAnchor="middle">
              {deg(activeDay.min)}
            </text>
          </>
        )}
        {/* Precipitation: its own strip and scale, not a second y-axis on the temperatures. */}
        <g transform={`translate(0 ${TEMP_H})`}>
          {rains.map((v, i) =>
            v ? (
              <rect
                key={i}
                className={`rain${i === active ? " active" : ""}${series[i].day?.forecast ? " forecast" : ""}`}
                x={x(i) - barW / 2}
                y={RAIN_H - 16 - Math.max(2, (v / rainMax) * (RAIN_H - 20))}
                width={barW}
                height={Math.max(2, (v / rainMax) * (RAIN_H - 20))}
                rx={2}
              />
            ) : null,
          )}
          <line className="grid" x1={0} x2={W} y1={RAIN_H - 16} y2={RAIN_H - 16} />
          {series.map((s, i) => (
            <text key={i} className={`axis${i === focusIndex ? " focus" : ""}`} x={x(i)} y={RAIN_H - 3} textAnchor="middle">
              {f.weekdayMini(s.date)}
            </text>
          ))}
        </g>
        {/* Hit areas wider than the marks. */}
        {series.map((_, i) => (
          <rect key={i} className="hit" x={x(i) - step / 2} y={0} width={step} height={TEMP_H + RAIN_H} onMouseEnter={() => setHovered(i)} />
        ))}
      </svg>
      <div className="weather-chart-readout small muted" aria-live="polite">
        {f.shortDate(series[active].date)} · {deg(activeDay?.max)} / {deg(activeDay?.min)} · {mm(activeDay?.precipitation)}
        {activeDay?.precipitationProbability != null && ` (${Math.round(activeDay.precipitationProbability)} %)`}
      </div>
    </figure>
  );
}
