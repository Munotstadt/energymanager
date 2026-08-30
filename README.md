# energymanager

Energie-Dashboard & Ladesteuerung für Solarmanager (EKZ) und Kostal,
läuft komplett auf Cloudflare (Pages + Workers + D1).

**Architektur & Setup:** siehe [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md).

## Seiten

| Datei | Zweck |
|---|---|
| `index.html` | Dashboard (Tageswerte, Charts, Kennzahlen) |
| `live.html` | Live-Ansicht: aktuell, heute (hochgerechnet), Geräte |
| `geraete.html` | Gerätenutzung pro Monat |
| `car.html` | Ladesteuerung: Modus, Ziel-SoC, Start-Charging-Schwellenwerte |
| `settings.html` | Debug-Infos (API-Status) + CSV-Upload (Solarmanager/Kostal) |

## Backend

- **Worker `energymanager`** (`/workers`) — API unter `api.energy.munot.app`,
  D1-Zugriff, Car-Charging-Automation (Cron), Upload-Verarbeitung.
- **D1-Datenbank `energy`** — alle Tabellen (Tageswerte, Live-Daten,
  Konfiguration, Aktivitäts-Log).
- **Worker `collector-worker-solarmanager`** (separates Deployment,
  nicht in diesem Repo) — sammelt Live- und Tagesdaten von der
  Solar-Manager-Cloud-API.

Login für alle drei Domains (`energy.munot.app`, `api.energy.munot.app`,
`collector.energy.munot.app`) läuft über Cloudflare Access mit Google-SSO.

## Schema-Referenz

`schema/d1_schema.sql` dokumentiert alle Tabellen (nicht automatisch
ausgeführt).
