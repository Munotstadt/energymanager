// energy_production Worker
// Serves data for the new "Tagesansicht" (day view) subpage.
//
// Routes:
//   GET /api/day-summary?date=YYYY-MM-DD   sunrise/sunset/day_length + actual + estimate
//   GET /api/day-stats?date=YYYY-MM-DD     min/max/median/mean production for that month/day across all years
//   GET /api/day-intraday?date=YYYY-MM-DD  live production curve + meteo radiation/sunshine for that day
//
// Bindings (see wrangler.toml):
//   DB_ENERGY -> D1 "energy"  (solar_reference_daily, solarmanager_data, solarmanager_live_points)
//   DB_METEO  -> D1 "meteo"   (meteo_klo_hourly)

const ALLOWED_ORIGIN = "https://energy.munot.app";

function corsHeaders(origin) {
  const allowOrigin = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, origin, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

function isValidDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
}

// Day-of-year (1-366), matching the day_year convention used in solar_reference_daily.
function dayOfYear(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const diff = d - start;
  return Math.floor(diff / 86400000) + 1;
}

function monthDay(dateStr) {
  // "YYYY-MM-DD" -> "MM-DD"
  return dateStr.slice(5, 10);
}

function median(sortedValues) {
  const n = sortedValues.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 !== 0 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

async function handleDaySummary(url, env, origin) {
  const date = url.searchParams.get("date");
  if (!isValidDate(date)) return json({ error: "invalid or missing date" }, origin, 400);

  const dYear = dayOfYear(date);

  const refRow = await env.DB_ENERGY
    .prepare(
      `SELECT sunrise, sunset, day_length, production_kwh_av
       FROM solar_reference_daily WHERE day_year = ?`
    )
    .bind(dYear)
    .first();

  const actualRow = await env.DB_ENERGY
    .prepare(`SELECT Production_kWh FROM solarmanager_data WHERE Date_ISO = ?`)
    .bind(date)
    .first();

  return json(
    {
      date,
      day_year: dYear,
      sunrise: refRow?.sunrise ?? null,
      sunset: refRow?.sunset ?? null,
      day_length: refRow?.day_length ?? null,
      estimate_kwh: refRow?.production_kwh_av ?? null,
      actual_kwh: actualRow?.Production_kWh ?? null,
    },
    origin
  );
}

async function handleDayStats(url, env, origin) {
  const date = url.searchParams.get("date");
  if (!isValidDate(date)) return json({ error: "invalid or missing date" }, origin, 400);

  const md = monthDay(date); // e.g. "09-12"

  const rows = await env.DB_ENERGY
    .prepare(
      `SELECT Production_kWh FROM solarmanager_data
       WHERE strftime('%m-%d', Date_ISO) = ?
         AND Production_kWh IS NOT NULL
       ORDER BY Production_kWh`
    )
    .bind(md)
    .all();

  const values = rows.results.map((r) => r.Production_kWh);
  if (values.length === 0) {
    return json({ date, month_day: md, count: 0, min: null, max: null, median: null, mean: null }, origin);
  }

  const min = values[0];
  const max = values[values.length - 1];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const med = median(values);

  return json(
    {
      date,
      month_day: md,
      count: values.length,
      min,
      max,
      median: med,
      mean,
    },
    origin
  );
}

async function handleDayIntraday(url, env, origin) {
  const date = url.searchParams.get("date");
  if (!isValidDate(date)) return json({ error: "invalid or missing date" }, origin, 400);

  const liveRows = await env.DB_ENERGY
    .prepare(
      `SELECT timestamp, current_pv_generation
       FROM solarmanager_live_points
       WHERE date(timestamp) = ?
       ORDER BY timestamp`
    )
    .bind(date)
    .all();

  const meteoRows = await env.DB_METEO
    .prepare(
      `SELECT obs_datetime, radiation_wm2, sunshine_min
       FROM meteo_klo_hourly
       WHERE date(obs_datetime) = ?
       ORDER BY obs_datetime`
    )
    .bind(date)
    .all();

  return json(
    {
      date,
      production: liveRows.results.map((r) => ({
        timestamp: r.timestamp,
        pv_generation: r.current_pv_generation,
      })),
      meteo: meteoRows.results.map((r) => ({
        obs_datetime: r.obs_datetime,
        radiation_wm2: r.radiation_wm2,
        sunshine_min: r.sunshine_min,
      })),
    },
    origin
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === "/api/day-summary") return await handleDaySummary(url, env, origin);
      if (url.pathname === "/api/day-stats") return await handleDayStats(url, env, origin);
      if (url.pathname === "/api/day-intraday") return await handleDayIntraday(url, env, origin);

      return json({ error: "not found" }, origin, 404);
    } catch (err) {
      return json({ error: err.message || "internal error" }, origin, 500);
    }
  },
};
