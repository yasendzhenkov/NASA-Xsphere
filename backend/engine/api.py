"""A6 · HTTP API (contract I1). Run: uvicorn engine.api:app --app-dir backend --port 8000"""
import json, math
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from . import config, jobs, resolve as R

app = FastAPI(title='SPHEREx Blink engine', version='0.2')

@app.on_event('startup')
def _weekly():
    import os, threading, time
    if os.environ.get('WATCH_WEEKLY') != '1':
        return
    def loop():
        from . import watch
        while True:
            time.sleep(7 * 24 * 3600)
            try:
                watch.refresh()
            except Exception as e:   # never take the API down because NASA was busy
                print('weekly check failed:', e)
    threading.Thread(target=loop, daemon=True).start()
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['GET', 'POST'], allow_headers=['*'])   # public, read-only data

@app.middleware('http')
async def cache_headers(request, call_next):
    """Hashed build files never change → keep a year; frames → a day (sw.js refreshes them); pages/sw.js/JSON → always revalidate."""
    r = await call_next(request)
    p = request.url.path
    if r.status_code == 200 and 'cache-control' not in r.headers:
        if p.startswith('/assets/'):
            r.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        elif p.endswith(('.f32', '.png')):
            r.headers['Cache-Control'] = 'public, max-age=86400'
        else:
            r.headers['Cache-Control'] = 'no-cache'
    return r

class ViewReq(BaseModel):
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    bands: list[str] | None = None          # C4 band ids: D1..D6, D56. Default: the target's band + one more
    per_epoch: int | None = Field(None, ge=1, le=60)   # photos per detector per visit; None = automatic (matches the pre-warm cache)
    target_id: str | None = None

class Box(BaseModel):
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    w_arcmin: float = Field(gt=0)
    h_arcmin: float = Field(gt=0)

class ScanReq(BaseModel):
    box: Box
    band: str = 'D4'
    per_epoch: int = Field(6, ge=1, le=30)
    classify: bool = True   # False: only the photos (no object recognition) — much faster, frees the worker

def _target(tid):
    for t in config.targets():
        if t['id'] == tid:
            return t
    return None

@app.get('/resolve')
def resolve(q: str):
    m = R.resolve(q)
    if not m['matches']:
        raise HTTPException(404, dict(error='name-not-found', message=f'No object or coordinates found for "{q}". Try a name like "Barnard\'s Star" or coordinates like "269.45 4.77".'))
    return m

@app.post('/view')
def view(req: ViewReq):
    from processing.bands import BANDS
    bad = [b for b in (req.bands or []) if b not in BANDS]
    if bad:
        raise HTTPException(422, dict(error='bad-band', message=f'Unknown band(s) {bad}; use {list(BANDS)}.'))
    t = _target(req.target_id) if req.target_id else None
    return {'job': jobs.start_view(req.ra_deg, req.dec_deg, req.bands, req.per_epoch, t)}

@app.get('/view/{key}')
@app.get('/scan/{key}')
def job_status(key: str):
    j = jobs.get(key)
    if not j:
        raise HTTPException(404, dict(error='unknown-job', message='This job is not known. Start it with POST /view or /scan.'))
    return {k: v for k, v in j.items() if k != 'trace'}

@app.post('/scan')
def scan(req: ScanReq):
    b = req.box
    if max(b.w_arcmin, b.h_arcmin) > config.MAX_ZONE_ARCMIN:
        raise HTTPException(422, dict(error='zone-too-large', message=f'Draw a zone up to {config.MAX_ZONE_ARCMIN}′ wide for now.'))
    return {'job': jobs.start_scan(b.ra_deg, b.dec_deg, b.w_arcmin, b.h_arcmin, req.band, req.per_epoch, req.classify)}

@app.get('/object/{tid}')
def obj(tid: str):
    t = _target(tid)
    if not t:
        raise HTTPException(404, dict(error='name-not-found', message=f'No target "{tid}".'))
    notes = config.ROOT / 'science' / 'notes' / f'{tid}.md'
    return dict(target=t, notes=notes.read_text() if notes.exists() else None)

@app.get('/targets')
def targets():
    return [dict(id=t['id'], name=t['name'], kind=t['kind'], default_band=t['default_band']) for t in config.targets()]

# ---------- C4 bundles for the product UI (web/, Niklas): pre-built (processing) + live (engine), one URL scheme ----------
# Niklas's data layer (web/src/ui/lib/data.ts) reads /bundles/index.json, /bundles/<id>/meta.json, /bundles/<id>/<band>/manifest.json,
# frame files, /bundles/<id>/spectrum.json and /bundles/flags.json. Pre-built bundles lack meta/spectrum and nest the WCS under
# `grid`, so this adapter fills those in without changing processing's files. Live results appear as id "live-<job key>".
from fastapi.responses import FileResponse, JSONResponse
PREBUILT = config.ROOT / 'web' / 'public' / 'bundles'
REPORTS = config.ROOT / 'processing' / 'discovery' / 'reports'

def _bundle_dir(bid: str):
    if bid.startswith('live-'):
        d = config.CACHE / 'live' / bid[5:]
    else:
        d = PREBUILT / bid
    if '..' in bid or '/' in bid or not d.exists():
        raise HTTPException(404, dict(error='not-found', message=f'No bundle "{bid}".'))
    return d

def _norm_manifest(m: dict) -> dict:
    g = m.get('grid', {})
    m.setdefault('nx', g.get('nx')); m.setdefault('ny', g.get('ny')); m.setdefault('wcs', g.get('wcs'))
    lam = m.get('lam_range_um') or [None, None]
    for f in m.get('frames', []):
        if lam[0] is not None:
            f.setdefault('lam_mean_um', round((lam[0] + lam[1]) / 2, 3))
    return m

@app.get('/bundles/index.json')
def b_index():
    idx = json.loads((PREBUILT / 'index.json').read_text()) if (PREBUILT / 'index.json').exists() else []
    kinds = {t['id']: t['kind'] for t in config.targets()}
    for e in idx:
        e['kind'] = kinds.get(e['id'], e.get('kind'))
    return idx

@app.get('/bundles/flags.json')
def b_flags():
    return config.flags_dictionary() or {}

@app.get('/bundles/{bid}/meta.json')
def b_meta(bid: str):
    d = _bundle_dir(bid)
    t = next((x for x in config.targets() if x['id'] == bid), None)
    if t is None:   # live result: describe the field
        j = json.loads((d / 'job.json').read_text()) if (d / 'job.json').exists() else {}
        c = j.get('center') or j.get('box') or {}
        t = dict(id=bid, name=(j.get('target') or {}).get('name') or f"Field {c.get('ra_deg', 0):.4f} {c.get('dec_deg', 0):+.4f}",
                 aliases=[], kind='custom', ra_deg=c.get('ra_deg'), dec_deg=c.get('dec_deg'), ref_epoch=2016.0,
                 pmra_masyr=0.0, pmdec_masyr=0.0, default_band=next(iter((j.get('bands') or {'D4': 1})), 'D4'))
    mans = sorted(d.glob('*/manifest.json'))
    m = json.loads(mans[0].read_text()) if mans else {'frames': []}
    epochs = [dict(id=f['epoch'], label=f.get('label', ''), mjd_start=f['mjd'], mjd_end=f['mjd'], n=f.get('n_exposures')) for f in m['frames']]
    return {**t, 'epochs': epochs, 'release': config.COLLECTIONS}

@app.get('/bundles/{bid}/spectrum.json')
def b_spectrum(bid: str):
    full = PREBUILT / bid / 'spectrum_full.json'                    # one point per exposure (processing/spectrum.py)
    if '/' not in bid and '..' not in bid and full.exists():
        return JSONResponse(json.loads(full.read_text()))
    p = REPORTS / f'{bid}.json'
    if bid.startswith('live-'):
        p = _bundle_dir(bid) / 'report.json'
    if not p.exists():
        raise HTTPException(404, dict(error='not-found', message='No spectrum for this object yet.'))
    r = json.loads(p.read_text())
    t = next((x for x in config.targets() if x['id'] == bid), None)
    src = r['sources'][0] if r.get('sources') else None
    if t and r.get('sources'):
        # the target's own source: same Gaia id in the cross-match, else nearest to its motion-corrected position at that visit
        gid = (t.get('astrometry_source') or '').replace('Gaia DR3 ', '')
        hit = [s for s in r['sources'] if any(str(c.get('id')) == gid for c in s.get('crossmatch', []))] if gid.isdigit() else []
        if hit:
            src = hit[0]
        else:
            def d(s):
                p0 = s['positions'][0]; ra, dec = R.propagate(t, 2000.0 + (p0['mjd'] + 2400000.5 - 2451545.0) / 365.25)
                return 9e9 if s.get('class') == 'artefact' else math.hypot((p0['ra_deg'] - ra) * math.cos(math.radians(dec)), p0['dec_deg'] - dec)
            src = min(r['sources'], key=d)
    pts = [dict(wl_um=x['lam_um'], bw_um=0.0, flux=x['flux'], err=x['err'], mjd=next((p['mjd'] for p in src['positions'] if p['visit'] == x['visit']), 0),
                epoch=x['visit'], det=x['band'], flagged=x.get('quality') not in (None, 'ok')) for x in (src or {}).get('spectrum', [])]
    return dict(target_id=bid, aperture_px=3, units='µJy (aperture photometry, processing/discovery)', points=pts,
                official_tool='https://irsa.ipac.caltech.edu/applications/spherex/tool-spectrophotometry')

@app.get('/bundles/{bid}/gaia.json')
def b_gaia(bid: str):
    """Gaia DR3 stars (G < 19.5) + AllWISE sources in the field for the viewer's overlays (chunk B's cached IRSA queries)."""
    from processing.discovery.crossmatch import query_irsa
    m = b_meta(bid)
    if m.get('ra_deg') is None:
        raise HTTPException(404, dict(error='not-found', message='No position for this field.'))
    ra, dec = m['ra_deg'], m['dec_deg']
    # Movers' photos are centred on today's position, up to ~2′ from the catalogue position: query around the photo's centre
    for mf in sorted(_bundle_dir(bid).glob('D*/manifest.json')):
        wcs = (json.loads(mf.read_text()).get('grid') or {}).get('wcs') or {}
        if wcs.get('crval'):
            ra, dec = wcs['crval']; break
    rows = query_irsa('Gaia DR3', ra, dec, 0.08)   # covers the 393.6″ square's corners
    return dict(ref_epoch=2016.0, sources=[dict(ra_deg=r['ra'], dec_deg=r['dec'], pmra_masyr=r['pmra'] or 0.0, pmdec_masyr=r['pmdec'] or 0.0,
                                               plx_mas=r['parallax'] or 0.0, gmag=r['phot_g_mean_mag']) for r in rows],
                # AllWISE (W2 < 16) where WISE saw each source in ~2010, not moved: a mover sits away from its square.
                # CatWISE2020 would be newer, but its VizieR backup returns no rows and IRSA TAP is often down.
                ref_epoch_wise=2010.5, wise=[dict(ra_deg=r['ra'], dec_deg=r['dec'], pmra_masyr=0.0, pmdec_masyr=0.0, w2mag=r['w2mpro'])
                                             for r in query_irsa('AllWISE', ra, dec, 0.08)])

@app.get('/bundles/{bid}/{band}/manifest.json')
def b_manifest(bid: str, band: str):
    p = _bundle_dir(bid) / band / 'manifest.json'
    if '..' in band or not p.exists():
        raise HTTPException(404, dict(error='not-found', message=f'No band {band} for "{bid}".'))
    return JSONResponse(_norm_manifest(json.loads(p.read_text())))

@app.get('/bundles/{bid}/{band}/{name}')
def b_file(bid: str, band: str, name: str):
    p = _bundle_dir(bid) / band / name
    if '..' in band + name or '/' in name or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p)

@app.get('/reports/{bid}.json')
def b_report(bid: str):
    p = (_bundle_dir(bid) / 'report.json') if bid.startswith('live-') else REPORTS / f'{bid}.json'
    if not p.exists():
        raise HTTPException(404, dict(error='not-found', message='No scan report for this object yet.'))
    if bid.startswith('live-'):
        return FileResponse(p)   # live scans are annotated when they finish (scan.py)
    from . import ml
    return ml.annotate(json.loads(p.read_text()))   # pre-built reports: add the model's second opinion on the fly

# results: live bundles + reports (engine cache) and the pre-built bundles (processing) — same C4 format
(config.CACHE / 'live').mkdir(parents=True, exist_ok=True)
app.mount('/live', StaticFiles(directory=config.CACHE / 'live'), name='live')
_lib3d = config.ROOT / 'web' / 'lib3d'
if _lib3d.exists():
    app.mount('/lib3d', StaticFiles(directory=_lib3d), name='lib3d')
_explore = config.ROOT / 'web' / 'app'
if _explore.exists():
    app.mount('/explore', StaticFiles(directory=_explore, html=True), name='explore')   # any spot + zone scans (engine UI)
_dist = config.ROOT / 'web' / 'dist'
if _dist.exists():
    @app.get('/embed', include_in_schema=False)   # same page, minimal chrome (the share panel hands out /embed?... links);
    def embed():                                    # on Vercel this is the rewrite in web/vercel.json
        return FileResponse(_dist / 'index.html')
    app.mount('/', StaticFiles(directory=_dist, html=True), name='product')   # Niklas's product UI build (npm run build)
