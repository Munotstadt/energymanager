"""
Start-Charging-Automation fuer die Auto-Ladestation.

Laeuft alle 15 Minuten (GitHub Actions) und prueft, ob der aktuelle
Lademodus basierend auf Einspeisung/Netzbezug der letzten 30 Minuten
umgeschaltet werden soll.

Logik (mit User abgestimmt, 2026-08-23):
  - Ø Einspeisung (Wh, letzte 30') > min_einspeisung_wh
    UND aktueller Modus == 1 (Only solar)
      -> Modus auf 5 (Minimal & Solar) setzen  ("Laden startet")
  - Ø Netzbezug (Wh, letzte 30') > max_netzbezug_wh
    UND aktueller Modus == 5 (Minimal & Solar)
      -> Modus auf 1 (Only solar) setzen  ("Laden stoppt")

Die Automation greift NUR ein, wenn der aktuelle Modus bereits 1 oder 5
ist. Andere Modi (Fast Charge, Do not charge, Constant current, Charging
Target SoC/kWh, Aria) werden nicht angetastet, damit manuell gesetzte
Modi nicht ueberschrieben werden.

Schwellenwerte kommen aus config/car_charging_automation.json im Repo
(von car.html aus editierbar, hier direkt vom Checkout gelesen).

Hinweis: current_grid_power ist vorzeichenbehaftet (siehe live.html-
Legende): negativ = Einspeisung, positiv = Netzbezug.

Benoetigte Umgebungsvariablen:
    SM_EMAIL, SM_API_KEY_WRITE, SM_BASE_URL (optional)
    TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
"""

import os
import sys
import json
import base64

import requests
import libsql_experimental as libsql


def _env_or_default(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


SM_BASE_URL = _env_or_default("SM_BASE_URL", "https://cloud.solar-manager.ch")
SM_EMAIL = os.environ["SM_EMAIL"]
SM_API_KEY_WRITE = os.environ["SM_API_KEY_WRITE"]
TURSO_DATABASE_URL = os.environ["TURSO_DATABASE_URL"]
TURSO_AUTH_TOKEN = os.environ["TURSO_AUTH_TOKEN"]

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "config", "car_charging_automation.json",
)

MODE_ONLY_SOLAR = 1
MODE_MINIMAL_SOLAR = 5

AVG_WINDOW_MIN = 30


def basic_auth_header() -> str:
    raw = f"{SM_EMAIL}:{SM_API_KEY_WRITE}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def load_thresholds() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def resolve_ladestation_device_id(conn) -> str | None:
    rows = conn.execute(
        "SELECT device_id, Bezeichnung FROM solarmanager_devices"
    ).fetchall()
    for device_id, bezeichnung in rows:
        if (bezeichnung or "").strip().lower().startswith("ladestation"):
            return device_id
    return None


def avg_grid_power(conn) -> float | None:
    row = conn.execute(
        f"""
        SELECT AVG(current_grid_power) FROM solarmanager_live_points
        WHERE datetime(fetched_at) >= datetime('now', '-{AVG_WINDOW_MIN} minutes')
          AND current_grid_power IS NOT NULL
        """
    ).fetchone()
    return row[0] if row and row[0] is not None else None


def current_mode(conn, device_id: str) -> int | None:
    row = conn.execute(
        f"""
        SELECT raw_json FROM solarmanager_live_devices
        WHERE device_id = ?
          AND datetime(fetched_at) >= datetime('now', '-{AVG_WINDOW_MIN} minutes')
        ORDER BY fetched_at DESC LIMIT 1
        """,
        (device_id,),
    ).fetchone()
    if not row or not row[0]:
        return None
    try:
        data = json.loads(row[0])
    except (TypeError, ValueError):
        return None
    return data.get("currentMode")


def set_mode(device_id: str, mode: int):
    resp = requests.put(
        f"{SM_BASE_URL}/v1/control/car-charger/{device_id}",
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": basic_auth_header(),
        },
        json={"chargingMode": mode},
        timeout=15,
    )
    if resp.status_code not in (200, 204):
        raise RuntimeError(f"HTTP {resp.status_code} -- {resp.text}")


def main():
    thresholds = load_thresholds()
    min_einspeisung_wh = thresholds["min_einspeisung_wh"]
    max_netzbezug_wh = thresholds["max_netzbezug_wh"]

    conn = libsql.connect(TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN)

    device_id = resolve_ladestation_device_id(conn)
    if not device_id:
        print("Ladestation nicht in solarmanager_devices gefunden -- Abbruch.")
        return

    avg_grid = avg_grid_power(conn)
    if avg_grid is None:
        print("Keine Netz-Daten in den letzten 30 Minuten -- Abbruch.")
        return

    einspeisung_avg = -avg_grid if avg_grid < 0 else 0
    netzbezug_avg = avg_grid if avg_grid > 0 else 0

    mode = current_mode(conn, device_id)
    print(
        f"Geraet={device_id} aktueller Modus={mode} "
        f"Ø-Netz(30')={avg_grid:.0f}W Einspeisung={einspeisung_avg:.0f}W "
        f"Netzbezug={netzbezug_avg:.0f}W "
        f"Schwellen: min_einspeisung={min_einspeisung_wh}Wh max_netzbezug={max_netzbezug_wh}Wh"
    )

    if mode is None:
        print("Kein aktueller Lademodus ermittelbar -- Abbruch.")
        return

    if einspeisung_avg > min_einspeisung_wh and mode == MODE_ONLY_SOLAR:
        print(f"Einspeisung ueber Schwelle und Modus=Only solar -> setze Minimal & Solar ({MODE_MINIMAL_SOLAR}). Laden startet.")
        set_mode(device_id, MODE_MINIMAL_SOLAR)
    elif netzbezug_avg > max_netzbezug_wh and mode == MODE_MINIMAL_SOLAR:
        print(f"Netzbezug ueber Schwelle und Modus=Minimal & Solar -> setze Only solar ({MODE_ONLY_SOLAR}). Laden stoppt.")
        set_mode(device_id, MODE_ONLY_SOLAR)
    else:
        print("Keine Bedingung erfuellt (oder Modus nicht 1/5) -- keine Aenderung.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Fehler: {e}", file=sys.stderr)
        sys.exit(1)
