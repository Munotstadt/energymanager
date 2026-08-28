-- energymanager D1-Schema
-- Tabellennamen identisch zur bisherigen Turso-DB (munotstadtenergydb),
-- damit alle Skripte/Dashboards ohne Umbenennung weiterlaufen.

CREATE TABLE IF NOT EXISTS solarmanager_data (
  Date_ISO TEXT PRIMARY KEY,
  Date_Display TEXT,
  Consumption_kWh REAL,
  Production_kWh REAL,
  GridFrom_kWh REAL,
  GridTo_kWh REAL,
  Entfeuchter_Waschen_kWh REAL,
  Wasserpumpe_kWh REAL,
  Ladestation_kWh REAL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS kostal_data (
  Date_ISO TEXT PRIMARY KEY,
  Date_Display TEXT,
  Energy_Wh REAL,
  Energy_kWh REAL,
  updated_at TEXT
);

-- Bereits ueber die bestehenden Live/Daily-Stats-Worker befuellt.
-- Hier nur als Referenz/Fallback, falls die D1-DB neu aufgesetzt wird.
CREATE TABLE IF NOT EXISTS solarmanager_devices (
  device_id TEXT PRIMARY KEY,
  Bezeichnung TEXT
);

CREATE TABLE IF NOT EXISTS solarmanager_live_points (
  fetched_at TEXT,
  current_pv_generation REAL,
  current_consumption REAL,
  current_grid_power REAL,
  current_battery_power REAL,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS solarmanager_live_devices (
  fetched_at TEXT,
  device_id TEXT,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS solarmanager_daily_stats (
  stat_date TEXT PRIMARY KEY,
  consumption_wh REAL,
  production_wh REAL,
  self_consumption_wh REAL,
  self_consumption_rate REAL,
  self_sufficiency_rate REAL
);

CREATE TABLE IF NOT EXISTS solarmanager_daily_stats_by_device (
  stat_date TEXT,
  device_id TEXT,
  consumption_wh REAL,
  PRIMARY KEY (stat_date, device_id)
);

CREATE INDEX IF NOT EXISTS idx_live_points_fetched_at ON solarmanager_live_points(fetched_at);
CREATE INDEX IF NOT EXISTS idx_live_devices_device_fetched ON solarmanager_live_devices(device_id, fetched_at);
