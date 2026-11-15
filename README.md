# SPHEREx Blink

**Blink any patch of sky through NASA's SPHEREx survey and watch nearby stars, brown dwarfs and variables move and change.**

**Live app: https://spherex.169-58-49-49.sslip.io/**

NASA Space Apps Challenge 2026 · [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)

Videos: [30-second demo] · [2-minute explainer]

## What it does
- **Type a name or coordinates, see the sky blink.** Any catalogued name (typos forgiven, CDS Sesame fallback) or RA/Dec opens the same patch at every SPHEREx visit, played like a little video, the way the 1930 blink comparator found Pluto.
- **Makes 1–2 pixel motion visible.** Blink, difference and side-by-side modes, crosshair, motion track, Gaia DR3 and AllWISE overlays, and older 2MASS / AllWISE / NEOWISE frames for long-baseline context.
- **Uses the 102 colours properly.** Never blinks across mixed wavelengths: frames are co-added per detector (D1–D6) and per visit, coloured by wavelength, and a spectrum panel plots one point per exposure at the wavelength it saw.
- **Scans a zone for candidates.** Draw a box: the engine detects sources, links movers across visits, cross-matches Gaia DR3, CatWISE2020, AllWISE, 2MASS and SkyBoT asteroids, and labels each source (known star, known asteroid, candidate mover, variable, artefact) with a one-line reason.
- **Shareable and always current.** Every view is a URL (embeddable via `/embed`), candidate reports download as JSON, and a weekly job re-asks NASA for new SPHEREx photos and rebuilds views that gained some.

## How it works
1. **Resolve** — name or coordinates → RA/Dec; known fast movers are propagated to the observation date (`backend/engine/resolve.py`).
2. **Inventory** — which SPHEREx exposures cover the spot: live IRSA SIA query over DR1 + QR3 (wide and deep), with our own S3-header index as fallback when IRSA is down (`inventory.py`, `s3index.py`).
3. **Cutouts** — read only a small section of each exposure (image, flags, variance, zodi) straight from NASA's public S3 copy, subtract zodiacal light and residual background, mask bad pixels (`processing/frames.py`).
4. **Group and stack** — exposures grouped into visits (new visit after a 60-day gap; deep fields split by month), reprojected onto one north-up grid and inverse-variance co-added per detector per visit (`processing/frames.py`, `processing/exposures.py`).
5. **Align, difference, detect** — σ-normalised differences between visits, source detection per visit (plus a red-only D5+D6 pass for cold brown dwarfs), movers linked across ≥ 3 visits with a chance-alignment test (`processing/change.py`, `processing/discovery/detect.py`, `link.py`).
6. **Cross-match and label** — Gaia DR3 (propagated to each visit), CatWISE2020, AllWISE, 2MASS, SIMBAD names and SkyBoT asteroids, then rule-based classes and aperture photometry → spectrum and light curve (`processing/discovery/crossmatch.py`, `classify.py`, `photometry.py`).

Results are cached, so the five challenge targets (pre-warmed) open instantly.

## Challenge requirements → features
| Challenge asks | Where it is |
|---|---|
| Public web tool: enter RA/Dec, see SPHEREx images change over time "like a little video" | Search box on the sky map (name or coordinates via `/resolve`) → blink viewer; any other spot via **Fetch SPHEREx photos here (live)** (`/explore`, `POST /view`) |
| Test on Barnard's Star, ε Indi B, WISE 0855−0714, RW Aurigae, R Draconis | All five pre-built (3–4 visits each, `web/public/bundles/`) with a guided tour; measured motions match Gaia DR3 / CatWISE2020 (`processing/discovery/README.md`) |
| *Optional:* easy to update with new data releases | Releases listed in `config.yaml`; live SIA query; weekly re-check and rebuild (`backend/engine/watch.py`, `WATCH_WEEKLY=1`) |
| *Optional:* creative display of the 102 bands; co-add each of the six detectors for S/N | Inverse-variance co-add per detector per visit; band chips (D1–D6, D5+D6); false colour by wavelength (`web/src/ui/lib/palette.ts`) |
| *Optional:* spectra on the fly ("extra kudos") | Spectrum panel: one point per exposure, all six detectors (`processing/spectrum.py`, `/bundles/{id}/spectrum.json`); light curve per visit |
| *Optional:* add / subtract epochs | Difference mode (σ differences, `processing/change.py`); switch individual visits off in the Advanced drawer |
| *Optional:* user-chosen field of view | Zone scan: draw a box of any width × height (`POST /scan`); zoomable sky map |
| *Optional:* Gaia / WISE overlays | Gaia DR3 and AllWISE overlay toggles (`/bundles/{id}/gaia.json`); 2MASS / AllWISE / NEOWISE context frames (`processing/context.py`) |
| *Optional:* coordinates in the URL, embeddable | URL scheme (`web/src/ui/lib/url.ts`), share panel, `/embed?…` |
| *Optional:* metadata such as contamination flags | SPHEREx FLAGS overlay and dictionary (`data/flags.json`), saturated-core warnings |
| *Optional:* use Astropy and Aladin (CDS) | Astropy + reproject in the whole pipeline; Aladin Lite v3 survey imagery in the sky map and `/explore` |

## Run locally
Python 3.11+ and Node 20.
```bash
python -m venv venv && venv/bin/pip install -r backend/requirements.txt -r processing/requirements.txt
(cd web && npm ci && npm run build)                                          # product UI → web/dist, served by the engine
venv/bin/python -m uvicorn engine.api:app --app-dir backend --port 8000     # open http://127.0.0.1:8000/
(cd backend && ../venv/bin/python -m engine.prewarm)                        # optional: pre-load the 5 targets
```
More detail: [backend/README.md](backend/README.md), [processing/discovery/README.md](processing/discovery/README.md), [web/README.md](web/README.md).

## Team
Yasen · Sean · Quirce · Giorgi · Niklas

## Use of AI
- Code was written with help from AI coding assistants.
- The demo video's voice-over is AI text-to-speech.
- The zone report can add one optional AI-written summary of the measured numbers (off unless an API key is set on the server); classes come from the rules, not the AI.
- An ML classifier for sources is being trained by the team (in progress; training-data collector in `processing/dataset/`). It is not used in the live app yet.

## Data credits
NASA/IPAC Infrared Science Archive (IRSA): SPHEREx (DR1, QR3; public S3 copy `nasa-irsa-spherex`), WISE / AllWISE / CatWISE2020 / NEOWISE, 2MASS. ESA Gaia DR3. CDS (SIMBAD, Sesame, VizieR, Aladin Lite). IMCCE SkyBoT. Details in [data/SOURCES.md](data/SOURCES.md).

---

# Hackathon planning notes (internal)


**NASA Space Apps Challenge 2026 · [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)** (difficulty: Advanced)

> **Submission closes Sun 15 Nov 2026, 23:59 local time — we submit by 22:00.**

### What we're building (one sentence)
A public web tool where anyone types a star's name or sky coordinates and sees **the same patch of sky at each SPHEREx
epoch blinking like a little video**, so moving objects (nearby stars, brown dwarfs) and changing ones (variable stars) jump
out — with the motion explained, the 102 infrared colours usable, and a shareable link. It's the blink comparator that
found Pluto in 1930, for NASA's newest all-sky survey.

Must work on: **Barnard's Star · ε Indi B · WISE 0855−0714 · RW Aurigae · R Draconis**.

### Start here (everyone, 15 min)
1. Read this file and **[PLAN.md](PLAN.md)** (timeline, checkpoints, cut order).
2. Read **your role file**:

| Role | People | File |
|---|---|---|
| 1 · Data — prepare, classify, choose the data | **Yasen, Sean** | [roles/01-data.md](roles/01-data.md) |
| 2 · Processing — algorithm, pipeline, bridge to the frontend | **Quirce, Giorgi** | [roles/02-processing.md](roles/02-processing.md) |
| 3 · Product engineer — product, UX, design, submission | **Niklas** | [roles/03-product.md](roles/03-product.md) |

3. Read **[CONTRACTS.md](CONTRACTS.md)** (what you hand to whom, exact formats) and **[DECISIONS.md](DECISIONS.md)** (what's locked).
4. At kick-off: tick your row in PLAN.md §8 and keep your scopes updated in **[STATUS.md](STATUS.md)** (planning table now in [docs/status-hill-chart-planning.md](docs/status-hill-chart-planning.md)).

Each role file has: **mission · scopes (what "done" looks like) · decisions you must take (with a recommendation) ·
what to research · outputs & deadlines · dependencies/contracts · rabbit holes to avoid.**

### What the research already found (14 Nov)
- All data is public (IRSA SIA/TAP, cutout service, S3 bucket `nasa-irsa-spherex`), no login.
- The 5 targets have **3–4 SPHEREx epochs** each (R Draconis ~monthly: it's in the north ecliptic deep field).
- Motion between epochs is **only 1–2 pixels** (6.15″/px) — measured in real data for Barnard's Star and WISE 0855 and it
  matches their proper motions. The UI must make it visible (zoom, crosshair, track, difference mode, archival positions).
- **Each exposure sees the target at a different wavelength** (linear variable filter) → never blink across mixed wavelengths.
- Catalogue positions of fast movers are arcminutes off today → always propagate proper motion to the observation date.
- Bright targets (Barnard, RW Aur, R Dra) are saturated; WISE 0855 only appears at 3.8–5 µm after co-adding each epoch.
- Full research: [research/01-data.md](research/01-data.md) · [research/02-processing.md](research/02-processing.md) · [research/03-product.md](research/03-product.md). Working scripts: [spikes/](spikes/).

### Repo layout (planned)
```
data/            Data role: targets.json, inventory/, flags.json, bands.json, science-notes.md, scripts/
processing/      Processing role: frames.py, motion.py, spectrum.py, precompute.py, (api.py)
web/             Vite + React + TS app
  public/bundles/  precomputed bundles (Processing)
  src/viewer/ src/data/   <BlinkCanvas>, loaders (Giorgi)
  src/ui/ src/pages/ src/styles/   (Niklas)
design/          wireframes (Niklas)
submission/      video script, texts, references (Niklas + all)
spikes/          research scripts that already work + SIA tables for the 5 targets
research/        full research reports
```

### Rules of the road
- Branch per scope (`data/…`, `proc/…`, `web/…`), merge to `main` within hours, `main` always builds.
- Only edit folders you own (D16). Changing a contract = tell the consumers first.
- Words: say **"candidate"**, never "discovery". English everywhere. AI-generated media must be watermarked.
- Post in the team chat only when: blocked · a discovery changes a contract · a scope is done.

### Key links
SPHEREx at IRSA https://irsa.ipac.caltech.edu/Missions/spherex.html · Tutorials https://caltech-ipac.github.io/irsa-tutorials/spherex/ ·
Explanatory Supplement https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf · WiseView http://byw.tools/wiseview ·
Judging guide https://www.spaceappschallenge.org/resources/judging-awards-guide · Submission guide https://www.spaceappschallenge.org/resources/project-submission-guide/
