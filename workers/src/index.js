/**
 * energymanager-api
 *
 * Ersetzt folgende bisherige GitHub Actions (Turso) durch einen
 * Cloudflare Worker (D1):
 *   - car-charging-automation.yml  (Cron alle 15')
 *   - car-charger-control.yml      (manueller Dispatch -> jetzt HTTP-Endpoint)
 *   - process-upload.yml           (Push-Trigger -> jetzt HTTP-Upload)
 *   - process-kostal-upload.yml    (Push-Trigger -> jetzt HTTP-Upload)
 *
 * solarmanager-live / daily-stats laufen bereits als eigene Worker auf
 * derselben D1-DB (gleiche Tabellennamen wie bisher in Turso).
 */

const MODE_ONLY_SOLAR = 1;
const MODE_MINIMAL_SOLAR = 5;
const AVG_WINDOW_MIN = 30;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function nowZurich() {
  // Europe/Zurich Zeitstempel im Format DD.MM.YYYY HH:MM:SS
  const parts = new Intl.DateTimeFormat("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

function basicAuthHeader(email, key) {
  return "Basic " + btoa(`${email}:${key}`);
}

// Schreibschutz laeuft jetzt vollstaendig ueber Cloudflare Access
// (*.energy.munot.app) -- unauthentifizierte Requests erreichen den Worker
// gar nicht erst, ein zusaetzlicher Shared-Secret-Check ist nicht mehr noetig.

/* ---------------------------------------------------------------------- *
 * Car-Charging-Automation (bisher car_charging_automation.py, Cron 15')
 * ---------------------------------------------------------------------- */

async function resolveLadestationDeviceId(db) {
  const { results } = await db
    .prepare("SELECT device_id, Bezeichnung FROM solarmanager_devices")
    .all();
  for (const row of results || []) {
    if ((row.Bezeichnung || "").trim().toLowerCase().startsWith("ladestation")) {
      return row.device_id;
    }
  }
  return null;
}

async function avgGridPower(db) {
  const row = await db
    .prepare(
      `SELECT AVG(current_grid_power) AS avg_power FROM solarmanager_live_points
       WHERE datetime(fetched_at) >= datetime('now', ?)
         AND current_grid_power IS NOT NULL`
    )
    .bind(`-${AVG_WINDOW_MIN} minutes`)
    .first();
  return row && row.avg_power !== null ? row.avg_power : null;
}

async function currentMode(db, deviceId) {
  const row = await db
    .prepare(
      `SELECT raw_json FROM solarmanager_live_devices
       WHERE device_id = ?
         AND datetime(fetched_at) >= datetime('now', ?)
       ORDER BY fetched_at DESC LIMIT 1`
    )
    .bind(deviceId, `-${AVG_WINDOW_MIN} minutes`)
    .first();
  if (!row || !row.raw_json) return null;
  try {
    const data = JSON.parse(row.raw_json);
    return data.currentMode ?? null;
  } catch {
    return null;
  }
}

async function setChargerMode(env, deviceId, mode, extra = {}) {
  const resp = await fetch(`${env.SM_BASE_URL}/v1/control/car-charger/${deviceId}`, {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: basicAuthHeader(env.SM_EMAIL, env.SM_API_KEY_WRITE),
    },
    body: JSON.stringify({ chargingMode: mode, ...extra }),
  });
  if (![200, 204].includes(resp.status)) {
    throw new Error(`HTTP ${resp.status} -- ${await resp.text()}`);
  }
}

async function getThresholds(db, env) {
  // D1 ist die Quelle der Wahrheit (per car.html ueber /api/config/thresholds
  // pflegbar). CAR_CHARGING_THRESHOLDS_JSON dient nur als Fallback/Erststart.
  const row = await db
    .prepare("SELECT min_einspeisung_wh, max_netzbezug_wh FROM car_charging_config WHERE id = 1")
    .first();
  if (row && row.min_einspeisung_wh !== null && row.max_netzbezug_wh !== null) {
    return { min_einspeisung_wh: row.min_einspeisung_wh, max_netzbezug_wh: row.max_netzbezug_wh };
  }
  const fallback = JSON.parse(env.CAR_CHARGING_THRESHOLDS_JSON || "{}");
  if (fallback.min_einspeisung_wh !== undefined && fallback.max_netzbezug_wh !== undefined) {
    return fallback;
  }
  return null;
}

async function handleThresholdsGet(request, env) {
  const t = await getThresholds(env.DB, env);
  if (!t) return jsonResponse({ min_einspeisung_wh: null, max_netzbezug_wh: null });
  return jsonResponse(t);
}

async function handleThresholdsSet(request, env) {
  const body = await request.json();
  const minEinspeisungWh = Number(body.min_einspeisung_wh);
  const maxNetzbezugWh = Number(body.max_netzbezug_wh);
  if (!Number.isFinite(minEinspeisungWh) || minEinspeisungWh < 0 ||
      !Number.isFinite(maxNetzbezugWh) || maxNetzbezugWh < 0) {
    return jsonResponse({ error: "min_einspeisung_wh und max_netzbezug_wh (>= 0) erforderlich" }, 400);
  }
  await env.DB.prepare(`
    INSERT INTO car_charging_config (id, min_einspeisung_wh, max_netzbezug_wh, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      min_einspeisung_wh=excluded.min_einspeisung_wh,
      max_netzbezug_wh=excluded.max_netzbezug_wh,
      updated_at=excluded.updated_at`)
    .bind(minEinspeisungWh, maxNetzbezugWh, nowZurich())
    .run();
  return jsonResponse({ ok: true, min_einspeisung_wh: minEinspeisungWh, max_netzbezug_wh: maxNetzbezugWh });
}

/* ---------------------------------------------------------------------- *
 * Ziel-SoC (ersetzt config/car_target_soc.json, GitHub)
 * ---------------------------------------------------------------------- */

async function handleTargetSocGet(request, env) {
  const row = await env.DB
    .prepare("SELECT target_soc_percent FROM car_charging_config WHERE id = 1")
    .first();
  return jsonResponse({ target_soc_percent: row ? row.target_soc_percent : null });
}

async function handleTargetSocSet(request, env) {
  const body = await request.json();
  const val = Number(body.target_soc_percent);
  if (!Number.isFinite(val) || val < 0 || val > 100) {
    return jsonResponse({ error: "target_soc_percent (0-100) erforderlich" }, 400);
  }
  await env.DB.prepare(`
    INSERT INTO car_charging_config (id, target_soc_percent, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      target_soc_percent=excluded.target_soc_percent,
      updated_at=excluded.updated_at`)
    .bind(val, nowZurich())
    .run();
  return jsonResponse({ ok: true, target_soc_percent: val });
}

async function runCarChargingAutomation(env) {
  const db = env.DB;
  const thresholds = await getThresholds(db, env);
  if (!thresholds) {
    console.log("Keine Schwellenwerte konfiguriert (weder D1 noch CAR_CHARGING_THRESHOLDS_JSON) -- Abbruch.");
    return;
  }
  const minEinspeisungWh = thresholds.min_einspeisung_wh;
  const maxNetzbezugWh = thresholds.max_netzbezug_wh;
  const deviceId = await resolveLadestationDeviceId(db);
  if (!deviceId) {
    console.log("Ladestation nicht in solarmanager_devices gefunden -- Abbruch.");
    return;
  }

  const avgGrid = await avgGridPower(db);
  if (avgGrid === null) {
    console.log("Keine Netz-Daten in den letzten 30 Minuten -- Abbruch.");
    return;
  }

  const einspeisungAvg = avgGrid < 0 ? -avgGrid : 0;
  const netzbezugAvg = avgGrid > 0 ? avgGrid : 0;
  const mode = await currentMode(db, deviceId);

  console.log(
    `Geraet=${deviceId} aktueller Modus=${mode} Ø-Netz(30')=${avgGrid.toFixed(0)}W ` +
    `Einspeisung=${einspeisungAvg.toFixed(0)}W Netzbezug=${netzbezugAvg.toFixed(0)}W`
  );

  if (mode === null) {
    console.log("Kein aktueller Lademodus ermittelbar -- Abbruch.");
    return;
  }

  if (einspeisungAvg > minEinspeisungWh && mode === MODE_ONLY_SOLAR) {
    console.log(`Einspeisung ueber Schwelle -> setze Minimal & Solar (${MODE_MINIMAL_SOLAR}).`);
    await setChargerMode(env, deviceId, MODE_MINIMAL_SOLAR);
  } else if (netzbezugAvg > maxNetzbezugWh && mode === MODE_MINIMAL_SOLAR) {
    console.log(`Netzbezug ueber Schwelle -> setze Only solar (${MODE_ONLY_SOLAR}).`);
    await setChargerMode(env, deviceId, MODE_ONLY_SOLAR);
  } else {
    console.log("Keine Bedingung erfuellt -- keine Aenderung.");
  }
}

/* ---------------------------------------------------------------------- *
 * Admin: Lademodus manuell setzen (bisher car-charger-control.yml)
 * ---------------------------------------------------------------------- */

async function handleCarChargerControl(request, env) {
  const body = await request.json();
  const { device_id, charging_mode, target_soc, constant_current } = body;
  if (!device_id || charging_mode === undefined) {
    return jsonResponse({ error: "device_id und charging_mode erforderlich" }, 400);
  }
  const extra = {};
  if (Number(charging_mode) === 4 && constant_current) {
    extra.constantCurrentSetting = Math.round(Number(constant_current));
  }
  if (Number(charging_mode) === 7 && target_soc) {
    extra.chargingTargetSoc = Math.round(Number(target_soc));
  }
  try {
    await setChargerMode(env, device_id, Number(charging_mode), extra);
    return jsonResponse({ ok: true, device_id, charging_mode, ...extra });
  } catch (e) {
    return jsonResponse({ error: String(e) }, 502);
  }
}

/* ---------------------------------------------------------------------- *
 * Upload: Solarmanager-CSV (bisher process-upload.yml + process_solarmanager.py)
 * ---------------------------------------------------------------------- */

function parseCsv(text) {
  // Einfacher CSV-Parser (Komma-getrennt, optionale Anfuehrungszeichen) --
  // ausreichend fuer die EKZ-Solarmanager- und Kostal-Exportformate.
  const rows = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
  for (const line of lines) rows.push(splitCsvLine(line, ","));
  return rows;
}

function splitCsvLine(line, delim) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === delim && !inQuotes) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

async function handleSolarmanagerUpload(request, env) {
  const csvText = await request.text();
  const rows = parseCsv(csvText);
  if (rows.length < 2) return jsonResponse({ error: "leere/ungültige CSV" }, 400);

  const header = rows[0];
  const idx = (needle, exclude) =>
    header.findIndex((h) => h.toLowerCase().includes(needle.toLowerCase()) &&
      (!exclude || !h.toLowerCase().includes(exclude.toLowerCase())));

  const iDate = idx("Date");
  const iConsumption = idx("Consumption");
  const iProduction = idx("Production");
  let iEntfeuchter = header.findIndex((h) =>
    h.toLowerCase().includes("entfeuchter") && h.toLowerCase().includes("smart plug"));
  if (iEntfeuchter === -1) iEntfeuchter = idx("Entfeuchter", "activeDevice");
  let iWasserpumpe = header.findIndex((h) =>
    h.toLowerCase().includes("wasserpumpe") && h.toLowerCase().includes("smart plug"));
  if (iWasserpumpe === -1) iWasserpumpe = idx("Wasserpumpe", "activeDevice");
  const iLadestation = idx("Car Charging", "activeDevice") !== -1
    ? idx("Car Charging", "activeDevice") : idx("Ladestation", "activeDevice");

  if (iDate === -1 || iConsumption === -1 || iProduction === -1) {
    return jsonResponse({ error: "Pflichtspalten (Date/Consumption/Production) fehlen" }, 400);
  }

  const num = (v) => (v === undefined || v === "" || v === null ? 0 : Number(v));
  const INTERVAL_HOURS = 0.25;
  const daily = new Map();

  for (const r of rows.slice(1)) {
    const d = new Date(r[iDate]);
    if (isNaN(d.getTime())) continue;
    const zurich = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(d); // YYYY-MM-DD
    const dateDisplay = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich" }).format(d);

    const consumption = num(r[iConsumption]);
    const production = num(r[iProduction]);
    const gridFrom = Math.max(consumption - production, 0) * INTERVAL_HOURS / 1000;
    const gridTo = Math.max(production - consumption, 0) * INTERVAL_HOURS / 1000;

    const entry = daily.get(zurich) || {
      Date_ISO: zurich, Date_Display: dateDisplay,
      Consumption_kWh: 0, Production_kWh: 0, GridFrom_kWh: 0, GridTo_kWh: 0,
      Entfeuchter_Waschen_kWh: 0, Wasserpumpe_kWh: 0, Ladestation_kWh: 0,
    };
    entry.Consumption_kWh += consumption * INTERVAL_HOURS / 1000;
    entry.Production_kWh += production * INTERVAL_HOURS / 1000;
    entry.GridFrom_kWh += gridFrom;
    entry.GridTo_kWh += gridTo;
    if (iEntfeuchter !== -1) entry.Entfeuchter_Waschen_kWh += num(r[iEntfeuchter]) * INTERVAL_HOURS / 1000;
    if (iWasserpumpe !== -1) entry.Wasserpumpe_kWh += num(r[iWasserpumpe]) * INTERVAL_HOURS / 1000;
    if (iLadestation !== -1) entry.Ladestation_kWh += num(r[iLadestation]) * INTERVAL_HOURS / 1000;
    daily.set(zurich, entry);
  }

  const ts = nowZurich();
  const stmt = env.DB.prepare(`
    INSERT INTO solarmanager_data
      (Date_ISO, Date_Display, Consumption_kWh, Production_kWh, GridFrom_kWh, GridTo_kWh,
       Entfeuchter_Waschen_kWh, Wasserpumpe_kWh, Ladestation_kWh, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(Date_ISO) DO UPDATE SET
      Date_Display=excluded.Date_Display, Consumption_kWh=excluded.Consumption_kWh,
      Production_kWh=excluded.Production_kWh, GridFrom_kWh=excluded.GridFrom_kWh,
      GridTo_kWh=excluded.GridTo_kWh, Entfeuchter_Waschen_kWh=excluded.Entfeuchter_Waschen_kWh,
      Wasserpumpe_kWh=excluded.Wasserpumpe_kWh, Ladestation_kWh=excluded.Ladestation_kWh,
      updated_at=excluded.updated_at`);

  const batch = [];
  for (const e of daily.values()) {
    batch.push(stmt.bind(
      e.Date_ISO, e.Date_Display,
      round3(e.Consumption_kWh), round3(e.Production_kWh),
      round3(e.GridFrom_kWh), round3(e.GridTo_kWh),
      round3(e.Entfeuchter_Waschen_kWh), round3(e.Wasserpumpe_kWh), round3(e.Ladestation_kWh),
      ts
    ));
  }
  if (batch.length) await env.DB.batch(batch);

  return jsonResponse({ ok: true, days_written: batch.length });
}

function round3(n) { return Math.round(n * 1000) / 1000; }

/* ---------------------------------------------------------------------- *
 * Upload: Kostal-CSV (bisher process-kostal-upload.yml + process_kostal.py)
 * ---------------------------------------------------------------------- */

const MONTH_MAP = {
  jan: 1, feb: 2, mar: 3, maer: 3, "mär": 3, apr: 4, may: 5, mai: 5,
  jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12,
};

async function handleKostalUpload(request, env) {
  const csvText = await request.text();
  const rows = csvText.replace(/\r\n/g, "\n").split("\n")
    .filter((l) => l.length > 0)
    .map((l) => splitCsvLine(l, ";").map((c) => c.replace(/^"|"$/g, "")));
  if (rows.length < 2) return jsonResponse({ error: "leere/ungültige CSV" }, 400);

  const header = rows[0];
  const iDateTime = header.indexOf("DateTime");
  if (iDateTime === -1) return jsonResponse({ error: "Spalte DateTime fehlt" }, 400);

  const yearCols = [];
  header.forEach((h, i) => {
    const m = /^(\d{4})\s*\[Wh\]$/.exec(h);
    if (m) yearCols.push({ idx: i, year: Number(m[1]) });
  });
  if (!yearCols.length) return jsonResponse({ error: "keine Jahres-Spalten YYYY [Wh] gefunden" }, 400);

  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
  const out = new Map();

  for (const r of rows.slice(1)) {
    const raw = (r[iDateTime] || "").trim();
    const m = /^([A-Za-zÀ-ÿ]+)\.?\s+(\d{1,2})$/.exec(raw);
    if (!m) continue;
    const monthKey = m[1].replace(/\.$/, "").toLowerCase().slice(0, 3);
    const month = MONTH_MAP[monthKey];
    if (!month) continue;
    const day = Number(m[2]);

    for (const { idx, year } of yearCols) {
      const cell = (r[idx] || "").replace(",", ".").trim();
      if (cell === "") continue;
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");
      const dateIso = `${year}-${mm}-${dd}`;
      if (isNaN(Date.parse(dateIso))) continue;
      if (dateIso >= today) continue; // nur abgeschlossene Tage
      const energyWh = Number(cell);
      if (isNaN(energyWh)) continue;
      out.set(dateIso, {
        Date_ISO: dateIso,
        Date_Display: `${dd}.${mm}.${year}`,
        Energy_Wh: energyWh,
        Energy_kWh: round3(energyWh / 1000),
      });
    }
  }

  const ts = nowZurich();
  const stmt = env.DB.prepare(`
    INSERT INTO kostal_data (Date_ISO, Date_Display, Energy_Wh, Energy_kWh, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(Date_ISO) DO UPDATE SET
      Date_Display=excluded.Date_Display, Energy_Wh=excluded.Energy_Wh,
      Energy_kWh=excluded.Energy_kWh, updated_at=excluded.updated_at`);

  const batch = [...out.values()].map((e) =>
    stmt.bind(e.Date_ISO, e.Date_Display, e.Energy_Wh, e.Energy_kWh, ts));
  if (batch.length) await env.DB.batch(batch);

  return jsonResponse({ ok: true, days_written: batch.length });
}

/* ---------------------------------------------------------------------- *
 * Daten-API fuer die Dashboards (ersetzt data/solarmanager_daily.json /
 * direkten Turso-Zugriff aus dem Browser -- Pages ruft diese Endpunkte auf)
 * ---------------------------------------------------------------------- */

async function handleData(table, request, env) {
  const allowed = ["solarmanager_data", "kostal_data", "solarmanager_daily_stats"];
  if (!allowed.includes(table)) return jsonResponse({ error: "unbekannte Tabelle" }, 404);
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
  return jsonResponse({ generated_at: nowZurich(), row_count: results.length, data: results });
}

async function handleCarData(request, env) {
  const db = env.DB;

  const devicesRes = await db.prepare("SELECT device_id, Bezeichnung FROM solarmanager_devices").all();
  const devices = devicesRes.results || [];
  const ladestation = devices.find(d => (d.Bezeichnung || "").trim().toLowerCase().startsWith("ladestation"));
  const resolvedDeviceId = ladestation ? ladestation.device_id : null;
  const deviceLabel = ladestation
    ? (ladestation.Bezeichnung || "").replace(/_Wh$/, "").replace(/_/g, " ").trim()
    : "Ladestation";

  const [pointsRes, deviceRowsRes] = await Promise.all([
    db.prepare(`
      SELECT fetched_at, current_pv_generation, current_power_consumption
      FROM solarmanager_live_points
      WHERE datetime(fetched_at) >= datetime('now', ?)
      ORDER BY fetched_at`).bind(`-${AVG_WINDOW_MIN} minutes`).all(),
    db.prepare(`
      SELECT fetched_at, device_id, current_power, soc, raw_json
      FROM solarmanager_live_devices
      WHERE datetime(fetched_at) >= datetime('now', ?)
      ORDER BY fetched_at`).bind(`-${AVG_WINDOW_MIN} minutes`).all(),
  ]);

  const points = (pointsRes.results || []).map((p) => ({
    fetched_at: p.fetched_at,
    pv: p.current_pv_generation === null ? null : Number(p.current_pv_generation),
    consumption: p.current_power_consumption === null ? null : Number(p.current_power_consumption),
  }));

  const allRows = (deviceRowsRes.results || []).map((d) => ({
    fetched_at: d.fetched_at,
    device_id: d.device_id,
    power: d.current_power === null ? null : Number(d.current_power),
    soc: d.soc === null || d.soc === undefined ? null : Number(d.soc),
    raw_json: d.raw_json,
  }));

  const deviceRows = allRows.filter((d) => d.device_id === resolvedDeviceId);

  return jsonResponse({ points, deviceRows, allRows, deviceLabel, resolvedDeviceId });
}

async function handleLiveData(request, env) {
  const db = env.DB;
  const todayIso = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());

  const [pointsRes, deviceReadingsRes, deviceNamesRes, todayRow] = await Promise.all([
    db.prepare(`
      SELECT fetched_at, current_pv_generation, current_power_consumption,
             current_grid_power, current_battery_charge_discharge
      FROM solarmanager_live_points
      WHERE datetime(fetched_at) >= datetime('now', '-24 hours')
      ORDER BY fetched_at`).all(),
    db.prepare(`
      SELECT fetched_at, device_id, current_power
      FROM solarmanager_live_devices
      WHERE datetime(fetched_at) >= datetime('now', '-24 hours')
      ORDER BY fetched_at`).all(),
    db.prepare("SELECT device_id, Bezeichnung FROM solarmanager_devices").all(),
    db.prepare(`
      SELECT Consumption_kWh, Production_kWh, GridFrom_kWh, GridTo_kWh,
             Entfeuchter_Waschen_kWh, Wasserpumpe_kWh, Ladestation_kWh
      FROM solarmanager_data WHERE Date_ISO = ?`).bind(todayIso).first(),
  ]);

  const points = (pointsRes.results || []).map((p) => ({
    fetched_at: p.fetched_at,
    pv: p.current_pv_generation === null ? null : Number(p.current_pv_generation),
    consumption: p.current_power_consumption === null ? null : Number(p.current_power_consumption),
    grid: p.current_grid_power === null ? null : Number(p.current_grid_power),
    battery: p.current_battery_charge_discharge === null ? null : Number(p.current_battery_charge_discharge),
  }));

  const deviceReadings = (deviceReadingsRes.results || []).map((d) => ({
    fetched_at: d.fetched_at,
    device_id: d.device_id,
    power: d.current_power === null ? null : Number(d.current_power),
  }));

  const deviceNames = {};
  (deviceNamesRes.results || []).forEach((d) => {
    deviceNames[d.device_id] = (d.Bezeichnung || d.device_id || "").replace(/_Wh$/, "").replace(/_/g, " ");
  });

  const dayTotals = todayRow ? {
    consumption: Number(todayRow.Consumption_kWh) || 0,
    production: Number(todayRow.Production_kWh) || 0,
    gridFrom: Number(todayRow.GridFrom_kWh) || 0,
    gridTo: Number(todayRow.GridTo_kWh) || 0,
    Entfeuchter: Number(todayRow.Entfeuchter_Waschen_kWh) || 0,
    Wasserpumpe: Number(todayRow.Wasserpumpe_kWh) || 0,
    Ladestation: Number(todayRow.Ladestation_kWh) || 0,
  } : null;

  return jsonResponse({ points, deviceReadings, deviceNames, dayTotals });
}

/* ---------------------------------------------------------------------- *
 * Router
 * ---------------------------------------------------------------------- */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCarChargingAutomation(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const cors = {
      "access-control-allow-origin": "https://energy.munot.app",
      "access-control-allow-headers": "content-type, x-admin-secret",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-credentials": "true",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      let resp;
      if (pathname === "/api/upload/solarmanager" && request.method === "POST") {
        resp = await handleSolarmanagerUpload(request, env);
      } else if (pathname === "/api/upload/kostal" && request.method === "POST") {
        resp = await handleKostalUpload(request, env);
      } else if (pathname === "/api/admin/car-charger-control" && request.method === "POST") {
        resp = await handleCarChargerControl(request, env);
      } else if (pathname === "/api/config/thresholds" && request.method === "GET") {
        resp = await handleThresholdsGet(request, env);
      } else if (pathname === "/api/config/thresholds" && request.method === "POST") {
        resp = await handleThresholdsSet(request, env);
      } else if (pathname === "/api/config/target-soc" && request.method === "GET") {
        resp = await handleTargetSocGet(request, env);
      } else if (pathname === "/api/config/target-soc" && request.method === "POST") {
        resp = await handleTargetSocSet(request, env);
      } else if (pathname === "/api/data/live" && request.method === "GET") {
        resp = await handleLiveData(request, env);
      } else if (pathname === "/api/data/car" && request.method === "GET") {
        resp = await handleCarData(request, env);
      } else if (pathname.startsWith("/api/data/") && request.method === "GET") {
        resp = await handleData(pathname.replace("/api/data/", ""), request, env);
      } else {
        resp = jsonResponse({ error: "not found" }, 404);
      }
      for (const [k, v] of Object.entries(cors)) resp.headers.set(k, v);
      return resp;
    } catch (e) {
      return jsonResponse({ error: String(e) }, 500);
    }
  },
};
