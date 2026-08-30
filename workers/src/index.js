/**
 * collector-worker-solarmanager
 *
 * Zwei Cron-Jobs in einem Worker:
 *
 * 1) Alle 10 Minuten: Live-Datenpunkt sammeln (unveraendert). Tagsüber
 *    (Sonnenaufgang-Sonnenuntergang) bei jedem Lauf, nachts nur alle
 *    30 Minuten (Minute 0 oder 30).
 * 2) Taeglich 01:00 UTC: Tagesstatistik-Sync (NEU, ersetzt das bisherige
 *    fetch-solarmanager-daily-stats.yml / GitHub Actions). Aktualisiert ein
 *    rollierendes Fenster abgeschlossener Kalendertage (Europe/Zurich) in
 *    solarmanager_daily_stats, solarmanager_daily_stats_by_device und
 *    solarmanager_data (Gateway- + Geraete-Werte zusammengefuehrt).
 *
 * Benötigte Secrets (Dashboard: Settings -> Variables -> Encrypted):
 *   SM_EMAIL       -> Solar Manager Login-E-Mail
 *   SM_API_KEY     -> Solar Manager Cloud API Key (Read)
 *   SM_GATEWAY_ID  -> Solar Manager Geräte-/Gateway-ID (SM-ID)
 *
 * Benötigte Variablen (Dashboard: Settings -> Variables, unverschlüsselt):
 *   SM_BASE_URL      -> https://cloud.solar-manager.ch
 *   SM_POINT_PATH    -> /v1/stream/gateway/{gateway_id}
 *   SM_LAT           -> 47.4808  (Niederhasli)
 *   SM_LON           -> 8.4808   (Niederhasli)
 *   SM_ROLLING_DAYS  -> "3"  (optional, Fenstergroesse fuer Tagesstatistik-Sync)
 *
 * Benötigtes Binding (Dashboard: Settings -> Bindings -> D1 Database):
 *   DB -> Datenbank "energy"
 *
 * Cron Triggers im Dashboard unter Settings -> Trigger Events:
 *   alle 10 Minuten   ->  */10 * * * *
 *   taeglich 01:00 UTC ->  0 1 * * *
 */

function basicAuthHeader(email, apiKey) {
	const raw = `${email}:${apiKey}`;
	return "Basic " + btoa(raw);
}

async function shouldRunNow(env, now) {
	const minute = now.getUTCMinutes();
	const lat = env.SM_LAT ?? "47.4808";
	const lon = env.SM_LON ?? "8.4808";

	try {
		const dateStr = now.toISOString().slice(0, 10);
		const url = `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&date=${dateStr}&formatted=0`;
		const resp = await fetch(url);
		const data = await resp.json();

		if (data.status !== "OK") throw new Error("sunrise-sunset API status != OK");

		const sunrise = new Date(data.results.sunrise);
		const sunset = new Date(data.results.sunset);

		const isDaytime = now >= sunrise && now <= sunset;

		if (isDaytime) return true; // tagsüber: jeder 10-Min-Lauf
		return minute === 0 || minute === 30; // nachts: nur alle 30 Min
	} catch (err) {
		console.error("Sonnenzeiten-Check fehlgeschlagen, führe sicherheitshalber aus:", err.message);
		return true; // Fallback: im Zweifel sammeln statt Datenlücke riskieren
	}
}

async function fetchPoint(env) {
	const path = env.SM_POINT_PATH.replace("{gateway_id}", env.SM_GATEWAY_ID);
	const baseUrl = env.SM_BASE_URL.replace(/\/+$/, "");
	const url = `${baseUrl}${path}`;

	const resp = await fetch(url, {
		headers: {
			accept: "application/json",
			authorization: basicAuthHeader(env.SM_EMAIL, env.SM_API_KEY),
		},
	});

	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`HTTP-Fehler ${resp.status} bei URL ${url}: ${body}`);
	}

	return await resp.json();
}

async function ensureSchema(db) {
	await db.batch([
		db.prepare(`
			CREATE TABLE IF NOT EXISTS solarmanager_live_points (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				fetched_at TEXT NOT NULL,
				timestamp TEXT,
				interface_version INTEGER,
				interval_secs INTEGER,
				current_battery_charge_discharge REAL,
				current_grid_power REAL,
				current_power_consumption REAL,
				current_pv_generation REAL,
				raw_json TEXT
			)
		`),
		db.prepare(`
			CREATE TABLE IF NOT EXISTS solarmanager_live_devices (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				fetched_at TEXT NOT NULL,
				device_id TEXT,
				signal TEXT,
				current_power REAL,
				soc INTEGER,
				e_wh REAL,
				i_wh REAL,
				raw_json TEXT
			)
		`),
	]);
}

async function storePoint(db, point) {
	const now = new Date().toISOString();

	const statements = [
		db
			.prepare(
				`INSERT INTO solarmanager_live_points
				(fetched_at, timestamp, interface_version, interval_secs,
				 current_battery_charge_discharge, current_grid_power,
				 current_power_consumption, current_pv_generation, raw_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				now,
				point.TimeStamp ?? null,
				point["Interface Version"] ?? null,
				point.intervalSecs ?? null,
				point.currentBatteryChargeDischarge ?? null,
				point.currentGridPower ?? null,
				point.currentPowerConsumption ?? null,
				point.currentPvGeneration ?? null,
				JSON.stringify(point)
			),
	];

	const devices = Array.isArray(point.devices) ? point.devices : [];
	for (const device of devices) {
		statements.push(
			db
				.prepare(
					`INSERT INTO solarmanager_live_devices
					(fetched_at, device_id, signal, current_power, soc, e_wh, i_wh, raw_json)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					now,
					device._id ?? null,
					device.signal ?? null,
					device.currentPower ?? device.currentPowerInvSm ?? null,
					device.soc ?? null,
					device.eWh ?? null,
					device.iWh ?? null,
					JSON.stringify(device)
				)
		);
	}

	await db.batch(statements);
}

async function collect(env) {
	const point = await fetchPoint(env);
	await ensureSchema(env.DB);
	await storePoint(env.DB, point);
	console.log("Datenpunkt in D1 (energy) gespeichert.");
}

/* ---------------------------------------------------------------------- *
 * Tagesstatistik-Sync (NEU, ersetzt fetch-solarmanager-daily-stats.yml)
 * ---------------------------------------------------------------------- */

const DAILY_STATS_DEVICE_IDS = [
	"65168ab128ec518afa0f665f",
	"6516885afd811a3c709c5bc2",
	"65d8b14d8c3c733fc7e1a3c2",
	"651bdb00fd811a3c70ec582a",
	"65b54af8be4cb07b15618b39",
	"68dd100001eb837abd21b2fd",
	"68dd114ae232d2c6444e11a2",
	"658153db411180774fe01246",
];

// Bezeichnung (aus solarmanager_devices) -> Spalte in solarmanager_data.
const DEVICE_COLUMN_MAP = {
	"Entfeuchter_Waschen_Wh": "Entfeuchter_Waschen_kWh",
	"Wasserpumpe_Wh": "Wasserpumpe_kWh",
	"Ladestation_Wh": "Ladestation_kWh",
};

const DAILY_STATS_SOURCE_LABEL = "Solar Manager Tagesstatistik -> D1";

function nowZurich() {
	const parts = new Intl.DateTimeFormat("de-CH", {
		timeZone: "Europe/Zurich",
		day: "2-digit", month: "2-digit", year: "numeric",
		hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
	}).formatToParts(new Date());
	const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
	return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

function round3(n) {
	return Math.round(n * 1000) / 1000;
}

function lastNCompleteDaysZurich(n) {
	// Liste von {dateIso, fromIso, toIso} fuer die letzten n abgeschlossenen
	// Kalendertage in Schweizer Lokalzeit (DST-aware).
	const fmtParts = (d) => {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit",
			hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
		}).formatToParts(d);
		return Object.fromEntries(parts.map((x) => [x.type, x.value]));
	};
	const nowP = fmtParts(new Date());
	const todayLocalMidnightUtc = new Date(Date.UTC(
		Number(nowP.year), Number(nowP.month) - 1, Number(nowP.day), 0, 0, 0
	));
	const offsetCheck = fmtParts(todayLocalMidnightUtc);
	const offsetHours = (Number(offsetCheck.hour) <= 12)
		? -Number(offsetCheck.hour)
		: 24 - Number(offsetCheck.hour);
	const trueMidnightUtc = new Date(todayLocalMidnightUtc.getTime() + offsetHours * 3600 * 1000);

	const days = [];
	for (let i = n; i >= 1; i--) {
		const dayStartUtc = new Date(trueMidnightUtc.getTime() - i * 86400 * 1000);
		const dayEndUtc = new Date(trueMidnightUtc.getTime() - (i - 1) * 86400 * 1000);
		const dateIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(dayStartUtc);
		days.push({
			dateIso,
			fromIso: dayStartUtc.toISOString().replace(/\.\d+Z$/, ".000Z"),
			toIso: dayEndUtc.toISOString().replace(/\.\d+Z$/, ".000Z"),
		});
	}
	return days;
}

async function fetchGatewayDayStats(env, fromIso, toIso) {
	const baseUrl = env.SM_BASE_URL.replace(/\/+$/, "");
	const url = `${baseUrl}/v1/statistics/gateways/${env.SM_GATEWAY_ID}?accuracy=day&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
	const resp = await fetch(url, {
		headers: { accept: "application/json", authorization: basicAuthHeader(env.SM_EMAIL, env.SM_API_KEY) },
	});
	if (!resp.ok) throw new Error(`Gateway-Stats HTTP ${resp.status}: ${await resp.text()}`);
	return resp.json();
}

async function fetchDeviceRange(env, deviceId, fromIso, toIso) {
	const baseUrl = env.SM_BASE_URL.replace(/\/+$/, "");
	const url = `${baseUrl}/v3/devices/${deviceId}/data/range?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&interval=900`;
	const resp = await fetch(url, {
		headers: { accept: "application/json", authorization: basicAuthHeader(env.SM_EMAIL, env.SM_API_KEY) },
	});
	if (!resp.ok) throw new Error(`Device-Range HTTP ${resp.status}: ${await resp.text()}`);
	const payload = await resp.json();
	if (Array.isArray(payload)) return payload;
	for (const key of ["data", "values", "points", "result", "results"]) {
		if (Array.isArray(payload[key])) return payload[key];
	}
	return [];
}

function sumDeviceDayWh(points) {
	return points.reduce((sum, p) => sum + (p.iWh || 0), 0);
}

async function ensureDailyStatsSchema(db) {
	await db.batch([
		db.prepare(`
			CREATE TABLE IF NOT EXISTS solarmanager_daily_stats (
				stat_date TEXT PRIMARY KEY,
				fetched_at TEXT,
				consumption_wh REAL,
				production_wh REAL,
				self_consumption_wh REAL,
				self_consumption_rate REAL,
				raw_json TEXT
			)
		`),
		db.prepare(`
			CREATE TABLE IF NOT EXISTS solarmanager_daily_stats_by_device (
				stat_date TEXT,
				device_id TEXT,
				fetched_at TEXT,
				consumption_wh REAL,
				PRIMARY KEY (stat_date, device_id)
			)
		`),
	]);
}

async function runDailyStatsSync(env) {
	const db = env.DB;
	await ensureDailyStatsSchema(db);

	const rollingDays = Number(env.SM_ROLLING_DAYS || "3");
	const days = lastNCompleteDaysZurich(rollingDays);
	const ts = nowZurich();

	// 1) Gateway-Gesamtsumme pro Tag
	const gatewayStatsByDate = {};
	for (const { dateIso, fromIso, toIso } of days) {
		let stats;
		try {
			stats = await fetchGatewayDayStats(env, fromIso, toIso);
		} catch (e) {
			console.log(`Gateway-Stats fuer ${dateIso} fehlgeschlagen: ${e}`);
			continue;
		}
		gatewayStatsByDate[dateIso] = stats;
		await db.prepare(`
			INSERT INTO solarmanager_daily_stats
				(fetched_at, stat_date, consumption_wh, production_wh, self_consumption_wh, self_consumption_rate, raw_json)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(stat_date) DO UPDATE SET
				fetched_at=excluded.fetched_at, consumption_wh=excluded.consumption_wh,
				production_wh=excluded.production_wh, self_consumption_wh=excluded.self_consumption_wh,
				self_consumption_rate=excluded.self_consumption_rate, raw_json=excluded.raw_json`)
			.bind(ts, dateIso, stats.consumption ?? null, stats.production ?? null,
				stats.selfConsumption ?? null, stats.selfConsumptionRate ?? null, JSON.stringify(stats))
			.run();
	}

	// 2) Pro Geraet und Tag
	const deviceWhByDateAndDevice = {};
	for (const deviceId of DAILY_STATS_DEVICE_IDS) {
		for (const { dateIso, fromIso, toIso } of days) {
			let points;
			try {
				points = await fetchDeviceRange(env, deviceId, fromIso, toIso);
			} catch (e) {
				console.log(`Geraete-Stats ${deviceId} fuer ${dateIso} fehlgeschlagen: ${e}`);
				continue;
			}
			const wh = sumDeviceDayWh(points);
			if (!deviceWhByDateAndDevice[dateIso]) deviceWhByDateAndDevice[dateIso] = {};
			deviceWhByDateAndDevice[dateIso][deviceId] = wh;
			await db.prepare(`
				INSERT INTO solarmanager_daily_stats_by_device (fetched_at, stat_date, device_id, consumption_wh)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(stat_date, device_id) DO UPDATE SET
					fetched_at=excluded.fetched_at, consumption_wh=excluded.consumption_wh`)
				.bind(ts, dateIso, deviceId, wh)
				.run();
		}
	}

	// 3) Zusammenfuehren in solarmanager_data
	const devicesRes = await db.prepare("SELECT device_id, Bezeichnung FROM solarmanager_devices").all();
	const bezeichnungByDevice = {};
	for (const row of devicesRes.results || []) {
		if (row.Bezeichnung && row.Bezeichnung.trim()) bezeichnungByDevice[row.device_id] = row.Bezeichnung.trim();
	}

	for (const { dateIso } of days) {
		const gatewayStats = gatewayStatsByDate[dateIso] || {};
		const deviceWhForDay = deviceWhByDateAndDevice[dateIso] || {};

		const deviceWhByColumn = {};
		for (const [deviceId, wh] of Object.entries(deviceWhForDay)) {
			const bezeichnung = bezeichnungByDevice[deviceId];
			const column = DEVICE_COLUMN_MAP[bezeichnung];
			if (column) deviceWhByColumn[column] = wh;
		}

		const consumptionWh = gatewayStats.consumption || 0;
		const productionWh = gatewayStats.production || 0;
		const selfConsumptionWh = gatewayStats.selfConsumption || 0;
		const gridFromKwh = Math.max(consumptionWh - selfConsumptionWh, 0) / 1000;
		const gridToKwh = Math.max(productionWh - selfConsumptionWh, 0) / 1000;

		const [year, month, day] = dateIso.split("-");
		const dateDisplay = `${day}.${month}.${year}`;

		await db.prepare(`
			INSERT INTO solarmanager_data
				(Date_ISO, Date_Display, Consumption_kWh, Production_kWh, GridFrom_kWh, GridTo_kWh,
				 Entfeuchter_Waschen_kWh, Wasserpumpe_kWh, Ladestation_kWh, updated_at, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(Date_ISO) DO UPDATE SET
				Date_Display=excluded.Date_Display, Consumption_kWh=excluded.Consumption_kWh,
				Production_kWh=excluded.Production_kWh, GridFrom_kWh=excluded.GridFrom_kWh,
				GridTo_kWh=excluded.GridTo_kWh, Entfeuchter_Waschen_kWh=excluded.Entfeuchter_Waschen_kWh,
				Wasserpumpe_kWh=excluded.Wasserpumpe_kWh, Ladestation_kWh=excluded.Ladestation_kWh,
				updated_at=excluded.updated_at, source=excluded.source`)
			.bind(
				dateIso, dateDisplay,
				round3(consumptionWh / 1000), round3(productionWh / 1000),
				round3(gridFromKwh), round3(gridToKwh),
				round3((deviceWhByColumn["Entfeuchter_Waschen_kWh"] || 0) / 1000),
				round3((deviceWhByColumn["Wasserpumpe_kWh"] || 0) / 1000),
				round3((deviceWhByColumn["Ladestation_kWh"] || 0) / 1000),
				ts, DAILY_STATS_SOURCE_LABEL
			)
			.run();
	}

	console.log(`Tagesstatistik-Sync fertig: ${days.length} Tage aktualisiert.`);
}

export default {
	async scheduled(controller, env, ctx) {
		if (controller.cron === "0 1 * * *") {
			ctx.waitUntil(runDailyStatsSync(env));
			return;
		}
		ctx.waitUntil(
			(async () => {
				const now = new Date();
				const run = await shouldRunNow(env, now);
				if (!run) {
					console.log("Übersprungen (Nacht, ausserhalb 30-Min-Raster).");
					return;
				}
				await collect(env);
			})()
		);
	},

	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/sync-daily-stats") {
			try {
				await runDailyStatsSync(env);
				return new Response("OK: Tagesstatistik synchronisiert.", { status: 200 });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error("Fehler:", message);
				return new Response(`Fehler: ${message}`, { status: 500 });
			}
		}
		try {
			await collect(env);
			return new Response("OK: Datenpunkt gespeichert.", { status: 200 });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("Fehler:", message);
			return new Response(`Fehler: ${message}`, { status: 500 });
		}
	},
};
