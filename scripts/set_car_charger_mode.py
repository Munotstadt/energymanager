"""
Solar Manager CLOUD API -> Auto-Ladestation steuern (PUT /v1/control/car-charger/{sensorId})

Wird ausschliesslich ueber GitHub Actions (workflow_dispatch) ausgefuehrt,
damit der Solar Manager API-Key nie im Browser landet. car.html loest den
Workflow per GitHub-PAT aus und uebergibt die Inputs unten als Umgebungs-
variablen.

Benoetigte Umgebungsvariablen:
    SM_EMAIL, SM_API_KEY, SM_BASE_URL  -> wie bei den bestehenden Fetch-Skripten
    DEVICE_ID           -> sensorId der Ladestation (aus solarmanager_devices)
    CHARGING_MODE         -> 0-8, siehe Mapping unten
    TARGET_SOC (optional)    -> fuer Mode 7 (Charging Target SoC), in %
    CONSTANT_CURRENT (optional) -> fuer Mode 4 (Constant Current), in A

Endpunkt-Doku (Swagger):
    0 = Fast Charge
    1 = Only solar
    2 = Solar & tariff optimized
    3 = Do not charge
    4 = Constant current
    5 = Minimal & Solar
    6 = Charging Target(kWh)
    7 = Charging Target(SoC)
    8 = Aria
"""

import os
import sys
import json
import base64

import requests


def _env_or_default(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


SM_BASE_URL = _env_or_default("SM_BASE_URL", "https://cloud.solar-manager.ch")
SM_EMAIL = os.environ["SM_EMAIL"]
# Control-Endpunkte (PUT) brauchen einen Key mit Write-Scope, getrennt vom
# read-only SM_API_KEY der Fetch-Pipelines.
SM_API_KEY = os.environ["SM_API_KEY_WRITE"]

DEVICE_ID = os.environ["DEVICE_ID"]
CHARGING_MODE = int(os.environ["CHARGING_MODE"])
TARGET_SOC = os.environ.get("TARGET_SOC") or None
CONSTANT_CURRENT = os.environ.get("CONSTANT_CURRENT") or None

MODE_LABELS = {
    0: "Fast Charge", 1: "Only solar", 2: "Solar & tariff optimized",
    3: "Do not charge", 4: "Constant current", 5: "Minimal & Solar",
    6: "Charging Target(kWh)", 7: "Charging Target(SoC)", 8: "Aria",
}


def basic_auth_header() -> str:
    raw = f"{SM_EMAIL}:{SM_API_KEY}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def build_body() -> dict:
    body = {"chargingMode": CHARGING_MODE}
    if CHARGING_MODE == 4 and CONSTANT_CURRENT:
        body["constantCurrentSetting"] = int(float(CONSTANT_CURRENT))
    if CHARGING_MODE == 7 and TARGET_SOC:
        body["chargingTargetSoc"] = int(float(TARGET_SOC))
    return body


def main():
    body = build_body()
    label = MODE_LABELS.get(CHARGING_MODE, f"Mode {CHARGING_MODE}")
    print(f"Setze Lademodus fuer Geraet {DEVICE_ID}: {label} -> {json.dumps(body)}")

    resp = requests.put(
        f"{SM_BASE_URL}/v1/control/car-charger/{DEVICE_ID}",
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": basic_auth_header(),
        },
        json=body,
        timeout=15,
    )
    if resp.status_code not in (200, 204):
        print(f"Fehler: HTTP {resp.status_code} -- {resp.text}", file=sys.stderr)
        sys.exit(1)
    print(f"OK: HTTP {resp.status_code}. Lademodus gesetzt: {label}.")


if __name__ == "__main__":
    try:
        main()
    except requests.HTTPError as e:
        print(f"HTTP-Fehler: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Fehler: {e}", file=sys.stderr)
        sys.exit(1)
