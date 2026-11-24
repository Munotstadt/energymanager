// ekz-dynamic-price-collector
// Holt täglich um 18:00 Zürcher Zeit (Backup 20:00) den dynamischen EKZ-Stromtarif
// für den Folgetag und speichert ihn in D1 (DB "energy", Tabelle ekz_energy_prices_dynamic).
// EKZ publiziert ca. 17:50 Uhr. Cloudflare-Crons laufen in UTC, daher stündlich
// 16-19 UTC; ausgeführt wird nur zu den lokalen Stunden in RUN_HOURS (DST-sicher).

const API_URL = "https://api.tariffs.ekz.ch/v1/tariffs";
const ENERGY_TARIFF = "electricity_dynamic";
const GRID_TARIFF = "grid_400D_inclFees";
const TZ = "Europe/Zurich";
const RUN_HOURS = [18, 20]; // Zürcher Lokalzeit: Hauptabruf + Backup

// ---------- Zeit-Helfer (DST-sicher) ----------

// Zürcher Kalenderdatum (YYYY-MM-DD) und Stunde für einen UTC-Zeitpunkt
function zurichParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { ymd: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// UTC-Zeitpunkt von 00:00 Zürcher Lokalzeit eines Datums
function zurichMidnightUtc(ymd) {
  const guess = new Date(`${ymd}T00:00:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${ymd}T06:00:00Z`))
    .find((p) => p.type === "timeZoneName").value; // z.B. "GMT+02:00"
  const m = off.match(/GMT([+-])(\d{2}):(\d{2})/);
  const minutes = m ? (m[1] === "+" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(guess.getTime() - minutes * 60000);
}

// Zieltag = der Tag, für den EKZ ab ca. 17:50 Uhr (Vortag) publiziert.
// Ab 18:00 lokal -> morgen, davor (00:00-17:59) -> heute (= der am Vorabend publizierte Tag).
function targetWindow(now = new Date()) {
  const { ymd, hour } = zurichParts(now);
  const day = hour >= 18 ? addDays(ymd, 1) : ymd;
  const start = zurichMidnightUtc(day);
  const end = zurichMidnightUtc(addDays(day, 1));
  return { day, start, end };
}

// ---------- EKZ-API ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTariff(tariffName, win) {
  const url = new URL(API_URL);
  url.searchParams.set("tariff_name", tariffName);
  url.searchParams.set("start_timestamp", win.start.toISOString());
  url.searchParams.set("end_timestamp", win.end.toISOString());

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`EKZ API ${tariffName}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      // Sicherheitsfilter: nur Intervalle innerhalb des Zielfensters
      const prices = (json.prices || []).filter((p) => {
        const t = new Date(p.start_timestamp).getTime();
        return t >= win.start.getTime() && t < win.end.getTime();
      });
      if (prices.length === 0) throw new Error(`EKZ API ${tariffName}: keine Preise für ${win.day}`);
      return { publication_timestamp: json.publication_timestamp ?? null, prices };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(attempt * 10000);
    }
  }
  throw lastErr;
}

const pick = (arr, unit) => {
  const e = (arr || []).find((x) => x.unit === unit);
  return e && e.value != null ? Number(e.value) : null;
};

const toUtcIso = (s) => new Date(s).toISOString().replace(".000Z", "Z");

// Energie (electricity_dynamic) und Netz (grid_400D_inclFees) sind zwei Abrufe -> pro Intervall zusammenführen
function mergeRows(energy, grid) {
  const gridByStart = new Map(grid.prices.map((p) => [toUtcIso(p.start_timestamp), p]));
  return energy.prices.map((p) => {
    const validFrom = toUtcIso(p.start_timestamp);
    const g = gridByStart.get(validFrom);
    const electricity = pick(p.electricity, "CHF_kWh");
    const gridKwh = g ? pick(g.grid, "CHF_kWh") : pick(p.grid, "CHF_kWh");
    return {
      valid_from: validFrom,
      valid_to: toUtcIso(p.end_timestamp),
      electricity_CHFkWh: electricity,
      grid_CHFkWh: gridKwh,
      total_CHFkWh: electricity != null && gridKwh != null ? Math.round((electricity + gridKwh) * 1e5) / 1e5 : null,
      regional_fees_CHFkWh: pick(p.regional_fees, "CHF_kWh"),
      electricity_CHFm: pick(p.electricity, "CHF_m"),
      grid_CHFm: g ? pick(g.grid, "CHF_m") : pick(p.grid, "CHF_m"),
      metering_CHFm: pick(p.metering, "CHF_m"),
      publication_timestamp: energy.publication_timestamp,
    };
  });
}

async function loadRows(env, win) {
  const [energy, grid] = await Promise.all([
    fetchTariff(env.ENERGY_TARIFF || ENERGY_TARIFF, win),
    fetchTariff(env.GRID_TARIFF || GRID_TARIFF, win),
  ]);
  return mergeRows(energy, grid);
}

// ---------- D1 ----------

async function storeRows(env, rows) {
  const stmt = env.DB.prepare(`
    INSERT INTO ekz_energy_prices_dynamic
      (valid_from, valid_to, electricity_CHFkWh, grid_CHFkWh, total_CHFkWh, regional_fees_CHFkWh,
       electricity_CHFm, grid_CHFm, metering_CHFm, publication_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(valid_from) DO UPDATE SET
      valid_to = excluded.valid_to,
      electricity_CHFkWh = excluded.electricity_CHFkWh,
      grid_CHFkWh = excluded.grid_CHFkWh,
      total_CHFkWh = excluded.total_CHFkWh,
      regional_fees_CHFkWh = excluded.regional_fees_CHFkWh,
      electricity_CHFm = excluded.electricity_CHFm,
      grid_CHFm = excluded.grid_CHFm,
      metering_CHFm = excluded.metering_CHFm,
      publication_timestamp = excluded.publication_timestamp,
      modified_at = datetime('now')
  `);
  await env.DB.batch(
    rows.map((r) =>
      stmt.bind(
        r.valid_from, r.valid_to, r.electricity_CHFkWh, r.grid_CHFkWh, r.total_CHFkWh, r.regional_fees_CHFkWh,
        r.electricity_CHFm, r.grid_CHFm, r.metering_CHFm, r.publication_timestamp
      )
    )
  );
  return rows.length;
}

async function run(env, { dry = false } = {}) {
  const win = targetWindow();
  const rows = await loadRows(env, win);
  if (dry) return { day: win.day, dry: true, count: rows.length, sample: rows.slice(0, 3) };
  const written = await storeRows(env, rows);
  return { day: win.day, rows_written: written };
}

// ---------- Backfill (historische Preise) ----------
// GET /?backfill=2026-01-01..2026-01-31        schreibt (Upsert, idempotent)
// GET /?backfill=2026-01-01..2026-01-31&dry=1  nur zählen, nichts speichern
// Max. 31 Tage pro Aufruf (Subrequest-Limits); Zeitraum in Zürcher Kalendertagen, beide Enden inklusive.
const BACKFILL_MAX_DAYS = 31;
const BACKFILL_CHUNK_DAYS = 7;
const BACKFILL_ROWS_PER_STMT = 300;

const sqlNum = (v) => (v == null || !Number.isFinite(Number(v)) ? "NULL" : String(Number(v)));
const sqlIso = (v) => (typeof v === "string" && /^[0-9T:+\-.Z]{10,40}$/.test(v) ? `'${v}'` : "NULL");

async function storeRowsBulk(env, rows) {
  const stmts = [];
  for (let i = 0; i < rows.length; i += BACKFILL_ROWS_PER_STMT) {
    const values = rows.slice(i, i + BACKFILL_ROWS_PER_STMT).map((r) =>
      `(${sqlIso(r.valid_from)},${sqlIso(r.valid_to)},${sqlNum(r.electricity_CHFkWh)},${sqlNum(r.grid_CHFkWh)},${sqlNum(r.total_CHFkWh)},${sqlNum(r.regional_fees_CHFkWh)},${sqlNum(r.electricity_CHFm)},${sqlNum(r.grid_CHFm)},${sqlNum(r.metering_CHFm)},${sqlIso(r.publication_timestamp)})`
    );
    stmts.push(env.DB.prepare(`
      INSERT INTO ekz_energy_prices_dynamic
        (valid_from, valid_to, electricity_CHFkWh, grid_CHFkWh, total_CHFkWh, regional_fees_CHFkWh,
         electricity_CHFm, grid_CHFm, metering_CHFm, publication_timestamp)
      VALUES ${values.join(",")}
      ON CONFLICT(valid_from) DO UPDATE SET
        valid_to = excluded.valid_to,
        electricity_CHFkWh = COALESCE(excluded.electricity_CHFkWh, electricity_CHFkWh),
        grid_CHFkWh = COALESCE(excluded.grid_CHFkWh, grid_CHFkWh),
        total_CHFkWh = COALESCE(excluded.total_CHFkWh, total_CHFkWh),
        regional_fees_CHFkWh = COALESCE(excluded.regional_fees_CHFkWh, regional_fees_CHFkWh),
        electricity_CHFm = COALESCE(excluded.electricity_CHFm, electricity_CHFm),
        grid_CHFm = COALESCE(excluded.grid_CHFm, grid_CHFm),
        metering_CHFm = COALESCE(excluded.metering_CHFm, metering_CHFm),
        publication_timestamp = COALESCE(excluded.publication_timestamp, publication_timestamp),
        modified_at = datetime('now')`));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return rows.length;
}

async function backfill(env, spec, { dry = false } = {}) {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(spec || "");
  if (!m) throw new Error("Format: ?backfill=YYYY-MM-DD..YYYY-MM-DD");
  const [, from, to] = m;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (!(days >= 1)) throw new Error("'bis' liegt vor 'von'");
  if (days > BACKFILL_MAX_DAYS) throw new Error(`Max. ${BACKFILL_MAX_DAYS} Tage pro Aufruf (angefragt: ${days})`);

  const chunks = [];
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, BACKFILL_CHUNK_DAYS)) {
    const last = addDays(d, BACKFILL_CHUNK_DAYS - 1) < to ? addDays(d, BACKFILL_CHUNK_DAYS - 1) : to;
    const win = { day: d, start: zurichMidnightUtc(d), end: zurichMidnightUtc(addDays(last, 1)) };
    const energy = await fetchTariff(env.ENERGY_TARIFF || ENERGY_TARIFF, win);
    let grid = { publication_timestamp: null, prices: [] }, gridOk = true;
    try { grid = await fetchTariff(env.GRID_TARIFF || GRID_TARIFF, win); } catch (e) { gridOk = false; }
    const rows = mergeRows(energy, grid);
    if (!dry) await storeRowsBulk(env, rows);
    total += rows.length;
    chunks.push({ from: d, to: last, rows: rows.length, grid_ok: gridOk, first: rows[0]?.valid_from, publication: energy.publication_timestamp });
  }
  return { backfill: `${from}..${to}`, dry, rows: total, chunks };
}

export default {
  // Manueller Abruf: GET /  (schreibt)  oder  GET /?dry=1  (nur anzeigen, nichts speichern)
  async fetch(request, env) {
    try {
      const q = new URL(request.url).searchParams;
      const dry = q.get("dry") === "1";
      if (q.get("backfill")) return Response.json({ success: true, ...(await backfill(env, q.get("backfill"), { dry })) });
      return Response.json({ success: true, ...(await run(env, { dry })) });
    } catch (err) {
      return Response.json({ success: false, error: err.message }, { status: 500 });
    }
  },
  // Cron: stündlich 16-19 UTC; läuft nur um 18:00 und 20:00 Zürcher Zeit.
  // Der 20-Uhr-Lauf ist das Backup und schreibt idempotent (Upsert), auch wenn 18 Uhr geklappt hat.
  async scheduled(event, env, ctx) {
    const { hour } = zurichParts(new Date(event.scheduledTime));
    if (!RUN_HOURS.includes(hour)) {
      console.log(JSON.stringify({ skipped: true, zurich_hour: hour }));
      return;
    }
    try {
      const result = await run(env);
      console.log(JSON.stringify({ zurich_hour: hour, ...result }));
    } catch (err) {
      console.error(JSON.stringify({ zurich_hour: hour, error: err.message }));
      throw err;
    }
  },
};
