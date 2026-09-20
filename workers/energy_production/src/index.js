// retry 
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

// Day-of-year on a fixed non-leap reference year (2001), so Feb-29 rows just
// fall on Mar-1 — good enough for a +/-15 day seasonal window, avoids having
// to special-case leap years when comparing month/day across many years.
function fixedDayOfYear(month, day) {
  const d = Date.UTC(2001, month - 1, day);
  const start = Date.UTC(2001, 0, 1);
  return Math.floor((d - start) / 86400000) + 1;
}

function circularDayDiff(a, b, yearLen = 365) {
  const diff = Math.abs(a - b);
  return Math.min(diff, yearLen - diff);
}

async function handleDayLengthYear(url, env, origin) {
  const date = url.searchParams.get("date");
  if (!isValidDate(date)) return json({ error: "invalid or missing date" }, origin, 400);

  const centerDoy = dayOfYear(date);

  const rows = await env.DB_ENERGY
    .prepare(`SELECT day_year, day_length FROM solar_reference_daily ORDER BY day_year`)
    .all();
  const byDoy = {};
  rows.results.forEach((r) => { byDoy[r.day_year] = r.day_length; });
  const totalDays = rows.results.length || 365;

  const series = [];
  for (let offset = -182; offset <= 182; offset++) {
    const doy = ((centerDoy - 1 + offset) % totalDays + totalDays) % totalDays + 1;
    series.push({ offset, day_year: doy, day_length: byDoy[doy] ?? null });
  }

  return json({ date, center_day_year: centerDoy, series }, origin);
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Datum um N Jahre verschieben, Feb-29 faellt in einem Nicht-Schaltjahr auf Feb-28.
function shiftYearStr(dateStr, deltaYears) {
  const y = parseInt(dateStr.slice(0, 4), 10) + deltaYears;
  const m = parseInt(dateStr.slice(5, 7), 10);
  let d = parseInt(dateStr.slice(8, 10), 10);
  if (m === 2 && d === 29 && !isLeapYear(y)) d = 28;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDaysStr(dateStr, days) {
  const d = new Date(Date.UTC(
    parseInt(dateStr.slice(0, 4), 10),
    parseInt(dateStr.slice(5, 7), 10) - 1,
    parseInt(dateStr.slice(8, 10), 10)
  ));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRangeStrs(fromStr, toStr) {
  const out = [];
  let cur = fromStr;
  // Safety cap so a malformed range can't loop forever.
  for (let i = 0; i < 3660 && cur <= toStr; i++) {
    out.push(cur);
    cur = addDaysStr(cur, 1);
  }
  return out;
}

async function handleDayTable(url, env, origin) {
  const to = url.searchParams.get("to");
  const from = url.searchParams.get("from") || (to ? addDaysStr(to, -89) : null);
  if (!isValidDate(from) || !isValidDate(to) || from > to) {
    return json({ error: "invalid or missing from/to date" }, origin, 400);
  }

  // Formel-Koeffizienten aus der Config-Tabelle (id=1) lesen.
  const formulaRow = await env.DB_ENERGY
    .prepare(`SELECT x, coef_globalstrahlung, coef_schneedecke, updated_at FROM validation_formula WHERE id = 1`)
    .first();
  const coefX = formulaRow?.x ?? null;
  const coefRad = formulaRow?.coef_globalstrahlung ?? null;
  const coefSnow = formulaRow?.coef_schneedecke ?? null;

  // Fuer den 30-Tage-Varianz-Schnitt werden 30 zusaetzliche Tage vor "from" benoetigt.
  const extendedFrom = addDaysStr(from, -30);

  // Produktion
  const prodRows = await env.DB_ENERGY
    .prepare(`SELECT Date_ISO, Production_kWh FROM solarmanager_data WHERE Date_ISO BETWEEN ? AND ?`)
    .bind(extendedFrom, to)
    .all();
  const prodByDate = {};
  prodRows.results.forEach((r) => { prodByDate[r.Date_ISO] = r.Production_kWh; });

  // Produktion des gleichen Kalendertags vor 1 und 2 Jahren (fuer den Jahresvergleich).
  const y1From = shiftYearStr(from, -1), y1To = shiftYearStr(to, -1);
  const y2From = shiftYearStr(from, -2), y2To = shiftYearStr(to, -2);
  const [prodY1Rows, prodY2Rows] = await Promise.all([
    env.DB_ENERGY.prepare(`SELECT Date_ISO, Production_kWh FROM solarmanager_data WHERE Date_ISO BETWEEN ? AND ?`).bind(y1From, y1To).all(),
    env.DB_ENERGY.prepare(`SELECT Date_ISO, Production_kWh FROM solarmanager_data WHERE Date_ISO BETWEEN ? AND ?`).bind(y2From, y2To).all(),
  ]);
  const prodY1ByDate = {}, prodY2ByDate = {};
  prodY1Rows.results.forEach((r) => { prodY1ByDate[r.Date_ISO] = r.Production_kWh; });
  prodY2Rows.results.forEach((r) => { prodY2ByDate[r.Date_ISO] = r.Production_kWh; });

  // Planwert (solar_reference_daily, via day_year)
  const refRows = await env.DB_ENERGY
    .prepare(`SELECT day_year, production_kwh_av, sun_h_norm FROM solar_reference_daily`)
    .all();
  const planByDoy = {};
  const sunNormByDoy = {};
  refRows.results.forEach((r) => {
    planByDoy[r.day_year] = r.production_kwh_av;
    sunNormByDoy[r.day_year] = r.sun_h_norm;
  });

  // Globalstrahlung (DB_METEO, meteo_klo_daily.obs_date)
  const radRows = await env.DB_METEO
    .prepare(`SELECT obs_date, radiation_wm2, sunshine_min FROM meteo_klo_daily WHERE obs_date BETWEEN ? AND ?`)
    .bind(extendedFrom, to)
    .all();
  const radByDate = {};
  const sunshineActualByDate = {};
  radRows.results.forEach((r) => {
    radByDate[r.obs_date] = r.radiation_wm2;
    sunshineActualByDate[r.obs_date] = r.sunshine_min !== null && r.sunshine_min !== undefined ? r.sunshine_min / 60 : null; // Minuten -> Stunden
  });

  // Schneedecke (DB_SEESTRASSE, seestrasse52b_values, ParameterID=23, Spalte 'date' ist bereits ein reines Datum)
  let snowByDate = {};
  let snowError = null;
  try {
    const snowRows = await env.DB_SEESTRASSE
      .prepare(
        `SELECT date, value
         FROM seestrasse52b_values
         WHERE ParameterID = 23 AND date BETWEEN ? AND ?`
      )
      .bind(extendedFrom, to)
      .all();
    snowRows.results.forEach((r) => { snowByDate[r.date] = r.value; });
  } catch (err) {
    snowError = err.message;
  }

  // Pro Tag: Validation, Varianz berechnen (fuer den erweiterten Bereich, fuer den 30T-Schnitt)
  const extendedDates = dateRangeStrs(extendedFrom, to);
  const validationByDate = {};
  const varianceByDate = {};
  extendedDates.forEach((d) => {
    const production = prodByDate[d] ?? null;
    const globalstrahlung = radByDate[d] ?? null;
    const schneedecke = snowByDate[d] ?? null;
    let validation = null;
    if (globalstrahlung !== null && schneedecke !== null && coefRad !== null && coefSnow !== null && coefX !== null) {
      validation = Math.max(0, (globalstrahlung * coefRad + schneedecke * coefSnow + coefX) / 1000);
    }
    validationByDate[d] = validation;
    varianceByDate[d] = (production !== null && validation !== null) ? production - validation : null;
  });

  const requestedDates = dateRangeStrs(from, to);
  const rows = requestedDates.map((d) => {
    const production = prodByDate[d] ?? null;
    const doy = dayOfYear(d);
    const planwert = planByDoy[doy] ?? null;
    const globalstrahlung = radByDate[d] ?? null;
    const schneedecke = snowByDate[d] ?? null;
    const validation = validationByDate[d];
    const variance = varianceByDate[d];
    const sunshineActual = sunshineActualByDate[d] ?? null;
    const sunshineNorm = sunNormByDoy[doy] ?? null;

    const dateY1 = shiftYearStr(d, -1), dateY2 = shiftYearStr(d, -2);
    const productionY1 = prodY1ByDate[dateY1] ?? null;
    const productionY2 = prodY2ByDate[dateY2] ?? null;

    // Gleitender 30-Tage-Schnitt der Varianz, endend an diesem Tag (nur vorhandene Werte).
    const windowDates = dateRangeStrs(addDaysStr(d, -29), d);
    const windowValues = windowDates.map((wd) => varianceByDate[wd]).filter((v) => v !== null && v !== undefined);
    const variance30d = windowValues.length ? windowValues.reduce((a, b) => a + b, 0) / windowValues.length : null;

    return {
      date: d,
      production,
      planwert,
      globalstrahlung,
      schneedecke,
      validation,
      variance,
      variance30d,
      sunshineActual,
      sunshineNorm,
      productionY1, dateY1,
      productionY2, dateY2,
    };
  });

  return json(
    {
      from,
      to,
      formula: { x: coefX, coef_globalstrahlung: coefRad, coef_schneedecke: coefSnow, updated_at: formulaRow?.updated_at ?? null },
      snow_query_error: snowError,
      rows,
    },
    origin
  );
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
      `SELECT Date_ISO, Date_Display, Production_kWh FROM solarmanager_data
       WHERE strftime('%m-%d', Date_ISO) = ?
         AND Production_kWh IS NOT NULL
       ORDER BY Production_kWh`
    )
    .bind(md)
    .all();

  const values = rows.results.map((r) => r.Production_kWh);
  if (values.length === 0) {
    return json({ date, month_day: md, count: 0, min: null, max: null, minDate: null, maxDate: null, median: null, mean: null, avg30: null, avg30_count: 0 }, origin);
  }

  const min = values[0];
  const minDate = rows.results[0].Date_Display || rows.results[0].Date_ISO;
  const max = values[values.length - 1];
  const maxDate = rows.results[rows.results.length - 1].Date_Display || rows.results[rows.results.length - 1].Date_ISO;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const med = median(values);

  // "Schnitt 30 Tage": mean production across all years, for the +/-15 day
  // window around this calendar day (circular, so it wraps correctly around
  // the new year).
  const targetDoy = fixedDayOfYear(parseInt(md.slice(0, 2), 10), parseInt(md.slice(3, 5), 10));
  const allRows = await env.DB_ENERGY
    .prepare(
      `SELECT Date_ISO, Production_kWh FROM solarmanager_data WHERE Production_kWh IS NOT NULL`
    )
    .all();
  const windowValues = allRows.results
    .filter((r) => {
      const m = parseInt(r.Date_ISO.slice(5, 7), 10);
      const d = parseInt(r.Date_ISO.slice(8, 10), 10);
      const doy = fixedDayOfYear(m, d);
      return circularDayDiff(doy, targetDoy) <= 15;
    })
    .map((r) => r.Production_kWh);
  const avg30 = windowValues.length
    ? windowValues.reduce((a, b) => a + b, 0) / windowValues.length
    : null;

  return json(
    {
      date,
      month_day: md,
      count: values.length,
      min,
      minDate,
      max,
      maxDate,
      median: med,
      mean,
      avg30,
      avg30_count: windowValues.length,
      avg30_scanned: allRows.results.length, // diagnostic: total rows scanned before the +/-15d filter
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
      if (url.pathname === "/api/day-length-year") return await handleDayLengthYear(url, env, origin);
      if (url.pathname === "/api/day-table") return await handleDayTable(url, env, origin);

      return json({ error: "not found" }, origin, 404);
    } catch (err) {
      return json({ error: err.message || "internal error" }, origin, 500);
    }
  },
};
