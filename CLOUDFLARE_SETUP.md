# energymanager — Cloudflare-Architektur

Dieses Dokument beschreibt den Stand **nach** der Migration von
GitHub Actions + Turso zu Cloudflare (Workers, Pages, D1, Access).
Für die Migrationshistorie siehe Git-Log — dieses Dokument beschreibt
nur den aktuellen Ziel-Zustand.

## Überblick

```
Browser (Google-Login via Cloudflare Access)
        │
        ├── energy.munot.app            Cloudflare Pages (dieses Repo, Root "/")
        │   ├── index.html              Dashboard (Tagesdaten, Charts)
        │   ├── live.html               Live-Ansicht (aktuell/heute/Geräte)
        │   ├── geraete.html            Gerätenutzung pro Monat
        │   ├── car.html                Ladesteuerung (Modus, Ziel-SoC, Schwellenwerte)
        │   └── settings.html           Debug + CSV-Upload (Solarmanager/Kostal)
        │
        ├── api.energy.munot.app        Cloudflare Worker "energymanager" (workers/)
        │   └── D1 "energy"             Alle Tabellen, siehe unten
        │
        └── collector.energy.munot.app  Cloudflare Worker "collector-worker-solarmanager"
            (separates Setup, nicht in diesem Repo — siehe Abschnitt unten)
```

Alle drei Domains liegen unter derselben Cloudflare-Access-Anwendung
(`*.energy.munot.app` + `energy.munot.app`), Login per Google-SSO.
"Bypass options requests to origin" ist in dieser Access-Anwendung
aktiviert (nötig für CORS-Preflight zwischen den drei Domains).

## Worker `energymanager` (`/workers`)

Deployment: Cloudflare Workers Builds, verbunden mit diesem Repo,
Root-Verzeichnis `/workers`. Jeder Push auf `main` deployt automatisch.

### Cron

- `*/15 * * * *` — Car-Charging-Automation: liest Ø-Netzleistung der
  letzten 30 Min aus `solarmanager_live_points`, schaltet den
  Lademodus je nach Schwellenwerten in `car_charging_config`.

### HTTP-Endpunkte

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/data/solarmanager_data` | Tageswerte Solarmanager |
| GET | `/api/data/kostal_data` | Tageswerte Kostal |
| GET | `/api/data/solarmanager_daily_stats` | Tagesstatistik (Gateway) |
| GET | `/api/data/car_charging_activity_log` | Log: Lademodus-/Schwellenwert-Änderungen |
| GET | `/api/data/live` | Live-Punkte + Geräte, letzte 24h (für `live.html`) |
| GET | `/api/data/car` | Live-Daten speziell für `car.html` (inkl. SoC) |
| POST | `/api/upload/solarmanager` | CSV-Upload Solarmanager (roher CSV-Body) |
| POST | `/api/upload/kostal` | CSV-Upload Kostal (roher CSV-Body) |
| GET/POST | `/api/config/thresholds` | Schwellenwerte Car-Charging-Automation |
| GET/POST | `/api/config/target-soc` | Ziel-SoC für die Ladesteuerung |
| POST | `/api/admin/car-charger-control` | Lademodus manuell setzen |

Schreibzugriffe sind ausschliesslich über Cloudflare Access
abgesichert (Google-Login) — es gibt keinen zusätzlichen
Shared-Secret-Mechanismus mehr.

### Secrets/Variablen (Dashboard → Settings → Variables and Secrets)

- `SM_EMAIL` (Secret) — Solar-Manager-Login
- `SM_API_KEY_WRITE` (Secret) — Solar-Manager-API-Key mit Schreibrechten (Ladesteuerung)
- `SM_BASE_URL` (Var) — `https://cloud.solar-manager.ch`

### D1-Bindung

`DB` → Datenbank `energy` (`database_id` in `workers/wrangler.toml`).

## D1-Datenbank `energy` — Tabellen

| Tabelle | Befüllt von | Zweck |
|---|---|---|
| `solarmanager_data` | Worker-Upload-Endpoint + `collector-worker-solarmanager` (Daily-Sync) | Tageswerte Solarmanager |
| `kostal_data` | Worker-Upload-Endpoint | Tageswerte Kostal |
| `solarmanager_devices` | manuell/initial gepflegt | `device_id` → `Bezeichnung`-Mapping |
| `solarmanager_live_points` | `collector-worker-solarmanager` (alle 10 Min) | Momentanwerte PV/Verbrauch/Netz/Batterie |
| `solarmanager_live_devices` | `collector-worker-solarmanager` (alle 10 Min) | Momentanwerte pro Gerät (inkl. SoC, Rohdaten) |
| `solarmanager_daily_stats` | `collector-worker-solarmanager` (täglich 01:00 UTC) | Tagesstatistik Gateway (Gesamt) |
| `solarmanager_daily_stats_by_device` | `collector-worker-solarmanager` (täglich 01:00 UTC) | Tagesstatistik pro Gerät |
| `car_charging_config` | `energymanager`-Worker | Eine Zeile (`id=1`): Schwellenwerte + Ziel-SoC |
| `car_charging_activity_log` | `energymanager`-Worker | Protokoll aller Lademodus-/Schwellenwert-Änderungen |

Schema-Referenz: `schema/d1_schema.sql` (nicht automatisch ausgeführt,
dient nur als Dokumentation/Ausgangspunkt für eine Neuaufsetzung).

## Worker `collector-worker-solarmanager`

**Liegt nicht in diesem Repo** — eigenständiger Worker, direkt im
Cloudflare-Dashboard gepflegt (Quick Edit, kein Git-Deploy). Code wird
bei Bedarf im Chat-Verlauf bereitgestellt und manuell eingefügt.

- Cron `*/10 * * * *` — Live-Datenpunkt von der Solar-Manager-Cloud-API
  holen, in `solarmanager_live_points`/`solarmanager_live_devices`
  schreiben. Nachts (ausserhalb Sonnenauf-/-untergang) nur alle 30 Min.
- Cron `0 1 * * *` — Tagesstatistik-Sync: rollierendes Fenster
  abgeschlossener Kalendertage, schreibt `solarmanager_daily_stats`,
  `solarmanager_daily_stats_by_device` und `solarmanager_data`.
- `GET /` — manueller Trigger für den Live-Datenpunkt (wird vom
  "Aktualisieren"-Button in `live.html` aufgerufen).
- `GET /sync-daily-stats` — manueller Trigger für den Daily-Sync.
- Custom Domain `collector.energy.munot.app` (fällt unter dieselbe
  Access-Anwendung wie die anderen beiden Domains).

Secrets: `SM_EMAIL`, `SM_API_KEY` (Read-Key, separat vom
`SM_API_KEY_WRITE` des `energymanager`-Workers), `SM_GATEWAY_ID`,
`SM_BASE_URL`, `SM_POINT_PATH`, `SM_LAT`, `SM_LON`,
optional `SM_ROLLING_DAYS` (Standard 3).

## Cloudflare Pages (`energymanager-web`)

Root-Verzeichnis `/` dieses Repos, Custom Domain `energy.munot.app`.
Reines statisches HTML/CSS/JS, kein Build-Schritt. Jeder Push deployt
automatisch neu.

## Login (Cloudflare Access)

Zero Trust → Access → Applications, Public Hostnames:
- `*.energy.munot.app`
- `energy.munot.app`

Identity Provider: Google. Policy nach Bedarf (z. B. feste
E-Mail-Liste). "Bypass options requests to origin" ist aktiviert
(Advanced settings → CORS), sonst schlagen Cross-Origin-Fetches
zwischen den drei Domains fehl (Access fängt sonst auch den
CORS-Preflight ab).

Logout-Link in der Navigation: `/cdn-cgi/access/logout`.

## Was es nicht mehr gibt

- GitHub Actions Workflows (alle entfernt)
- Turso (`munotstadtenergydb`) — vollständig durch D1 ersetzt
- Client-seitige GitHub-PAT-Uploads — Uploads laufen jetzt direkt
  gegen den Worker (`settings.html`)
- `config/car_charging_automation.json`, `config/car_target_soc.json` —
  ersetzt durch die D1-Tabelle `car_charging_config`
- `data/solarmanager_daily.json` — ersetzt durch
  `GET /api/data/solarmanager_data`
- `logs/`, `processed/`, `processed_kostal/`, `uploads/`,
  `uploads_kostal/` — Artefakte der alten Python-Skripte/Actions,
  nicht mehr relevant
