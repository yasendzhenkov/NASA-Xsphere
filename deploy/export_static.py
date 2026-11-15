"""Static copy of the app for Vercel: the product UI (web/dist) + the 5 pre-built targets in the exact JSON the engine serves.
Run from the repo root after `cd web && npm run build`:   python deploy/export_static.py
Writes web/dist/bundles/... (meta, spectrum, gaia, normalised manifests, flags, index). Live views and zone scans
still need the engine (backend/), which vercel.json forwards to (ENGINE_URL)."""
import json, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from fastapi import HTTPException          # noqa: E402
from engine import api, ml                 # noqa: E402

OUT = ROOT / 'web' / 'dist' / 'bundles'

def put(rel, obj):
    p = OUT / rel; p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(json.loads(obj.body) if hasattr(obj, 'body') else obj))   # b_manifest returns a JSONResponse

idx = api.b_index(); put('index.json', idx); put('flags.json', api.b_flags())
for e in idx:
    bid = e['id']; put(f'{bid}/meta.json', api.b_meta(bid))
    for name, fn in (('spectrum.json', api.b_spectrum), ('gaia.json', api.b_gaia)):
        try:
            r = fn(bid)
            if name != 'gaia.json' or r['sources']:   # IRSA catalogue down → no overlay rather than an empty one
                put(f'{bid}/{name}', r)
        except HTTPException:
            pass                                  # UI handles a missing spectrum/overlay
    for band in e['bands']:
        put(f'{bid}/{band}/manifest.json', api.b_manifest(bid, band))
        src = api.PREBUILT / bid / band
        for f in src.iterdir():
            if f.suffix in ('.f32', '.png'):
                shutil.copy2(f, OUT / bid / band / f.name)
    rp = api.REPORTS / f'{bid}.json'
    if rp.exists():   # the same report the engine serves at /reports/<id>.json, plus the triage model's second opinion
        put(f'../reports/{bid}.json', ml.annotate(json.loads(rp.read_text())))
    print(bid, e['bands'])
explore = ROOT / 'web' / 'app'
shutil.copytree(explore, OUT.parent / 'explore', dirs_exist_ok=True)   # page only; its API calls go to the engine
