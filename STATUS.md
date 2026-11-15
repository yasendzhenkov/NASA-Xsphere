# Status: submitted state, 15 Nov 2026

What shipped, checked against the code on `main`. The planning hill chart from 14 Nov is kept in
[docs/status-hill-chart-planning.md](docs/status-hill-chart-planning.md).

## Shipped
- **Live app** at https://spherex.169-58-49-49.sslip.io/: sky map (Aladin Lite imagery), search by name or coordinates, blink / difference / side-by-side viewer, guided tour of the five targets, share and embed links (`web/`).
- **Engine** (`backend/engine/`): name and coordinate resolver with typo-tolerant names and CDS Sesame fallback; live IRSA SIA inventory with an S3-header index fallback; background jobs with caching; HTTP API (`/resolve`, `/view`, `/scan`, `/targets`, bundles, reports); pre-warm of the five targets; weekly re-check for new SPHEREx photos (`watch.py`); MCP server exposing the engine as tools.
- **Frame pipeline** (`processing/`): S3 section reads, zodi and background subtraction, flag masking, reprojection to a common grid, inverse-variance co-add per detector per visit, σ differences, C4 bundles; spectrum with one point per exposure; 2MASS / AllWISE / NEOWISE context frames.
- **Zone scan** (`processing/discovery/`): detection (incl. red-only pass), motion linking with chance-line test, cross-match with Gaia DR3, CatWISE2020, AllWISE, 2MASS, SIMBAD and SkyBoT, rule-based classes, aperture photometry, JSON report; fake-mover injection test.
- **Five targets** pre-built in `web/public/bundles/` (3–4 visits each). Measured motions in `processing/discovery/README.md` match Gaia DR3 / CatWISE2020.
- **Data layer** (`data/`, `science/`): target catalogue, flag dictionary, band windows, science notes, class rules.

## Not finished
- ML classifier: training-data collector exists (`processing/dataset/collect.py`); the model is in progress and not used by the app.
- Known limits of the candidate search (one-year baseline, slow movers, saturated photometry) are listed in `processing/discovery/README.md`.
