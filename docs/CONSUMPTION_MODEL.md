# Verbrauchsvalidierung (consumption.html)

Analog zur Produktionsvalidierung (production.html): der tatsächliche Verbrauch wird gegen ein Modell
aus Anwesenheit, Boiler-Legionellenschutz, Aussentemperatur, Heizung und Wochentag validiert.

## Zielgrösse

**Grundverbrauch = Gesamtverbrauch − Auto-Laden** (`solarmanager_data.Consumption_kWh − Ladestation_kWh`).
Das Laden des Autos ist ein separater Verbraucher und wird bewusst aus Ist, Soll und Varianz entfernt.

## Modell

```
Grundverbrauch_kWh = b0 + b1·AtHome + b2·Legionellenschutz + b3·max(0; 15 − T) + b4·Heizung + b5·Wochenende
```

| Treiber | Quelle |
|---|---|
| AtHome (0–1) | `seestrasse52b_values`, ParameterID 2 |
| Legionellenschutz (0/1) | `seestrasse52b_values`, ParameterID 6 |
| Heizgradtage max(0; 15 − T) | `meteo.meteo_klo_daily.temp_mean_c` |
| Heizung (0–1) | `seestrasse52b_values`, ParameterID 24 |
| Wochenende (Sa/So) | aus dem Datum |

Schätzung: OLS über die **gesamte Historie** (2023-10-01 bis 2026-09-30, 1096 Tage), einmalige 3σ-Ausreisserbereinigung
(13 Tage entfernt, n = 1083). Die Fenster 6/12 Monate in der Seite dienen nur der Bewertung, nicht der Schätzung.

### Koeffizienten (Stand 2026-10-01)

| Koeffizient | Wert (kWh/Tag) |
|---|---|
| Grundlast b0 | 15.14 |
| AtHome b1 | 4.61 |
| Legionellenschutz b2 | 2.24 |
| Heizgradtage b3 (je Grad-Tag) | 0.791 |
| Heizung b4 | 2.56 |
| Wochenende b5 | 2.37 |

Güte: R² 0.747, RMSE 3.33 kWh/Tag, Kreuzvalidierung (10 Blöcke) RMSE 4.00.
Bewertung auf Teilfenstern (Fit auf voller Historie): letzte 12 Monate R² 0.74 / RMSE 3.12 / Bias −0.76 kWh;
letzte 6 Monate R² 0.36 / RMSE 3.04 / Bias −0.20 kWh (R² ist im Sommer niedrig, weil die Streuung der Treiber klein ist).

### Varianten (volle Historie)

| Modell | R² | RMSE | CV-RMSE |
|---|---|---|---|
| A: AtHome + Legio + HDD | 0.708 | 3.57 | 4.27 |
| B: A + Heizung | 0.722 | 3.49 | 4.16 |
| C: B + Tageslänge | 0.724 | 3.48 | 4.20 |
| **D: B + Wochenende (gewählt)** | **0.747** | **3.33** | **4.00** |
| G: D + Tageslänge | 0.749 | 3.32 | 4.06 |

- **Heizgrenze:** 15 °C ist optimal (CV-RMSE-Minimum bei 15–16 °C; 12–20 °C getestet).
- **Tageslänge** verworfen: Koeffizient ≈ −0.2 kWh/h, CV-RMSE verschlechtert sich; Korrelation mit Heizgradtagen −0.80 (kollinear).
- **Quooker** verworfen: läuft nur bei Anwesenheit, kein eigener Erklärungsbeitrag neben AtHome.
- **Wochenende / Legionellenschutz** überlappen teilweise (Legionellenlauf meist Samstag oder Donnerstag, 86 von 155 Läufen Samstag);
  die Einzeleffekte sind deshalb mit etwas Unschärfe geschätzt.

### Vorläufige Faustregel (vor der Regression, Sprachnotiz) vs. Ergebnis

| | Schätzung | OLS |
|---|---|---|
| Grundlast | 10–12 | 15.1 |
| AtHome | 10–15 | 4.6 |
| Heizgradtage je Grad-Tag | 1.0–1.5 | 0.79 |

Die Faustwerte lagen deutlich daneben: Anwesenheit wirkt mit rund 5 kWh/Tag viel schwächer, die Grundlast ist höher.

## Speicherung

Die Koeffizienten stehen in der D1-Tabelle `energy.consumption_formula` (id = 1), analog zu `validation_formula`;
der Worker liest sie nur (kein Neufit bei jedem Seitenaufruf). Fehlt die Tabelle, fittet der Worker live (`formula.source = "live-fit"`).

- Schema und aktuelle Werte: `schema/consumption_formula.sql`
- Neuberechnung: `analysis/fit_consumption_model.py` (arbeitet auf dem Datenschnappschuss `analysis/data_raw.py` / `data_cp.py`,
  Stand 2026-09-30; für einen neuen Fit Schnappschuss neu aus D1 exportieren und die erzeugte SQL per
  `wrangler d1 execute energy --remote --file schema/consumption_formula.sql` ausführen).

## API (Worker `energy-production`)

- `GET /api/consumption-table?from=&to=` – Tageszeilen (Ist, Soll, Varianz, Varianz30d, Treiber, Vorjahre) und Formel
- `GET /api/consumption-day-stats?date=` – Min/Max/Median/Mittel und ±15-Tage-Schnitt des Grundverbrauchs für die Säule

Deployment des Workers: manuell im Cloudflare-Dashboard («Edit code»), da die Git-Integration dieses Workers defekt ist.
