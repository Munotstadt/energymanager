# energymanager → Cloudflare Migration: Setup-Anleitung

Alles bleibt im Repo `Munotstadt/energymanager`. Zwei Cloudflare-Produkte
zeigen auf dasselbe Repo:

- **Cloudflare Pages** → Ordner `/` (Frontend: index.html, car.html, live.html, ...)
- **Cloudflare Workers Builds** → Ordner `/workers` (Worker `energymanager-api`)

---

## 1. D1-Datenbank

Falls noch nicht vorhanden (sonst dieselbe DB wie der solarmanager-live/
daily-stats-Worker weiterverwenden — **eine** D1-DB für alle Tabellen):

```bash
wrangler d1 create energymanager
wrangler d1 execute energymanager --file=schema/d1_schema.sql --remote
```

`database_id` aus der Ausgabe in `workers/wrangler.toml` eintragen.

Datenmigration Turso → D1 (einmalig, pro Tabelle):

```bash
turso db shell munotstadtenergydb ".dump solarmanager_data" > sm.sql
turso db shell munotstadtenergydb ".dump kostal_data" >> sm.sql
# .dump-Output an SQLite/D1-Syntax anpassen (INSERT-Statements reichen meist),
# dann:
wrangler d1 execute energymanager --file=sm.sql --remote
```

---

## 2. Worker deployen (`/workers`)

```bash
cd workers
wrangler secret put SM_EMAIL
wrangler secret put SM_API_KEY_WRITE
wrangler secret put UPLOAD_SHARED_SECRET   # frei wählbares, langes Token
wrangler deploy
```

`CAR_CHARGING_THRESHOLDS_JSON` (ersetzt `config/car_charging_automation.json`)
am einfachsten als weiteres Secret/Var pflegen, z. B.:

```bash
wrangler secret put CAR_CHARGING_THRESHOLDS_JSON
# Eingabe: {"min_einspeisung_wh": 500, "max_netzbezug_wh": 300}
```

car.html müsste dann statt der Datei im Repo diesen Wert über einen neuen
`GET/POST /api/config/thresholds`-Endpoint lesen/schreiben — sag Bescheid,
falls das auch noch umgestellt werden soll (aktuell postet car.html noch
direkt gegen die JSON-Datei im Repo).

Danach in Cloudflare Dashboard **Workers & Pages → energymanager-api →
Settings → Builds**: Git-Repo `Munotstadt/energymanager` verbinden,
**Root directory: `/workers`**, damit jeder Push automatisch neu deployt
(= "GitHub als Push-Service").

---

## 3. Cloudflare Pages (Frontend + Domain)

1. **Workers & Pages → Create → Pages → Connect to Git** →
   `Munotstadt/energymanager`, Branch `main`, **Build output directory: `/`**
   (kein Build-Step nötig, reines statisches HTML).
2. **Custom domains** → `energy.munot.app` hinzufügen (DNS-Eintrag wird bei
   Domain in derselben Cloudflare-Zone automatisch vorgeschlagen).
3. Alter `deploy-pages.yml`-Workflow (Turso-Token-Injection) wird **gelöscht**
   — Pages baut jetzt direkt aus dem Repo, keine Token-Injection mehr nötig,
   da die Dashboards nicht mehr direkt gegen Turso/D1 sprechen, sondern
   gegen `energymanager-api` (`/api/data/...`).

---

## 4. Login: Google via Cloudflare Access

1. **Zero Trust Dashboard → Settings → Authentication → Login methods** →
   **Add → Google** (Client ID/Secret aus einem Google Cloud OAuth-Consent-
   Screen-Projekt, `https://<dein-team>.cloudflareaccess.com/cdn-cgi/access/callback`
   als Redirect-URI eintragen).
2. **Zero Trust → Access → Applications → Add an application → Self-hosted**:
   - Domain: `energy.munot.app`
   - Identity providers: Google (oben angelegt)
   - Policy: z. B. "Allow" für eure Google-Workspace-Domain oder eine feste
     E-Mail-Liste.
3. Damit ist die ganze Domain (Pages **und** darunterliegende `/api/...`-
   Aufrufe an den Worker, falls dieser ebenfalls hinter derselben Domain
   liegt) durch Google-Login geschützt — kein Code im Frontend nötig.

> Hinweis: `energymanager-api` selbst läuft unter `workers.dev` bzw. einer
> eigenen Route. Für Uploads von `solarmanageruploader.html` reicht der
> `UPLOAD_SHARED_SECRET`-Header, da diese Seite ohnehin hinter Access liegt
> (nur eingeloggte Nutzer sehen das Formular/Secret).

---

## 5. Frontend-Anpassungen (noch offen, nächster Schritt)

- `solarmanageruploader.html`: statt CSV via GitHub-Contents-API zu committen
  (`uploads/**.csv` → Push-Trigger), direkt `POST` an
  `https://energymanager-api.<account>.workers.dev/api/upload/solarmanager`
  (Body = rohe CSV, Header `x-admin-secret: <UPLOAD_SHARED_SECRET>`).
  Analog für Kostal: `/api/upload/kostal`.
- `index.html` / `live.html`: statt `data/solarmanager_daily.json` zu lesen,
  `GET /api/data/solarmanager_data` (bzw. `kostal_data`) vom Worker abrufen.
- `car.html`: "Lademodus setzen"-Button postet neu gegen
  `/api/admin/car-charger-control` statt einen GitHub-Workflow-Dispatch
  auszulösen.

Sobald das erledigt ist, können `process-upload.yml`, `process-kostal-
upload.yml`, `car-charging-automation.yml`, `car-charger-control.yml` und
`deploy-pages.yml` aus `.github/workflows/` gelöscht werden — Turso ist dann
vollständig entkoppelt.
