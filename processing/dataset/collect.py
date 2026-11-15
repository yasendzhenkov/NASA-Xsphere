"""Training-data collector for the future classifier (ml-plan.md, sets A/B/C).
Runs the engine's own zone scan (POST /scan) over many zones and keeps every raw I3 report, so features and labels
can be chosen later without re-downloading. Resumable: a zone with a saved report (or a saved error) is skipped.

  python -m processing.dataset.collect zones   # write zones.csv (A random sky, B brown dwarfs, C bright-star glare)
  python -m processing.dataset.collect run     # scan every zone not done yet (engine must run on :8000)
  python -m processing.dataset.collect table   # flatten reports -> sources.csv (features + catalogue labels apart)
"""
import csv, json, math, os, random, sys, time, urllib.request
from pathlib import Path

ENGINE = os.environ.get('SPHEREX_ENGINE', 'http://127.0.0.1:8000')   # e.g. http://127.0.0.1:4390 on the VPS
OUT = Path(__file__).resolve().parents[2] / 'cache' / 'ml-dataset'
ZONES = OUT / 'zones.csv'


def make_zones(n_random=40, n_bd=60, n_bright=10, seed=1):
    import pyvo
    rng = random.Random(seed)
    zones = []
    for i in range(n_random):  # uniform on the sphere
        zones.append(dict(id=f'A{i:03d}', set='A', name='random', ra=round(rng.uniform(0, 360), 5),
                          dec=round(math.degrees(math.asin(rng.uniform(-1, 1))), 5), size=10))
    bd = bright = []
    try:  # sets B/C need SIMBAD; when CDS is down, write set A now and re-run `zones` later (same seed, same A ids)
        tap = pyvo.dal.TAPService('https://simbad.cds.unistra.fr/simbad/sim-tap')
        bd = list(tap.search("SELECT main_id, ra, dec FROM basic WHERE otype='BD*' AND ra IS NOT NULL"))
        bright = list(tap.search("SELECT TOP 200 b.main_id, b.ra, b.dec FROM basic b JOIN flux f ON f.oidref=b.oid "
                                 "WHERE f.filter='V' AND f.flux < 4 AND b.ra IS NOT NULL"))
    except Exception as e:
        print('SIMBAD unreachable, only set A written:', str(e)[:120])
    for tag, rows, n, size in (('B', bd, n_bd, 6), ('C', bright, n_bright, 10)):
        for i, r in enumerate(rng.sample(rows, min(n, len(rows)))):
            zones.append(dict(id=f'{tag}{i:03d}', set=tag, name=str(r['main_id']), ra=round(float(r['ra']), 5),
                              dec=round(float(r['dec']), 5), size=size))
    OUT.mkdir(parents=True, exist_ok=True)
    with ZONES.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(zones[0])); w.writeheader(); w.writerows(zones)
    print(f'{len(zones)} zones -> {ZONES} ({len(bd)} SIMBAD brown dwarfs to draw from)')


def _http(path, body=None):
    req = urllib.request.Request(ENGINE + path, data=json.dumps(body).encode() if body else None,
                                 headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))


def run(timeout_s=1800):
    rep = OUT / 'reports'; rep.mkdir(parents=True, exist_ok=True)
    zs = list(csv.DictReader(ZONES.open()))
    for z in (zs[::-1] if os.environ.get('REVERSE') else zs):  # REVERSE=1: a 2nd worker from the other end
        dst, err = rep / f"{z['id']}.json", rep / f"{z['id']}.error.json"
        if dst.exists() or err.exists():
            continue
        t0 = time.time(); s = float(z['size'])
        try:
            key = _http('/scan', dict(box=dict(ra_deg=float(z['ra']), dec_deg=float(z['dec']), w_arcmin=s, h_arcmin=s),
                                    per_epoch=int(os.environ.get('PER_EPOCH', 6))))['job']  # fewer photos per visit = faster
            while True:
                time.sleep(5)
                j = _http(f'/scan/{key}')
                if j['status'] in ('done', 'error') or time.time() - t0 > timeout_s:
                    break
            if j['status'] == 'done':
                dst.write_text(json.dumps(dict(zone=z, job=key, report=j['report'])))
            elif j['status'] == 'error' and j.get('error') == 'outside-coverage':
                err.write_text(json.dumps(dict(zone=z, error=j.get('error'), message=j.get('message'))))
            # nasa-busy / internal / timeout: no file, so the next run retries it
            print(z['id'], z['name'], j['status'], j.get('error', ''), f'{time.time() - t0:.0f}s', flush=True)
        except Exception as e:
            print(z['id'], 'failed:', e, flush=True)


def table():
    # Catalogue matches are LABELS only (ml-plan rule 2: no answer leakage); everything else is a SPHEREx feature.
    rows = []
    for p in sorted((OUT / 'reports').glob('[A-Z][0-9]*[0-9].json')):
        d = json.loads(p.read_text()); z = d['zone']
        for s in d['report'].get('sources', []):
            m = s.get('motion') or {}
            row = dict(zone=z['id'], set=z['set'], source=s['id'], n_visits=m.get('n_visits'),
                       speed_arcsec_yr=m.get('speed_arcsec_yr'), pm_sig=m.get('sig'), fit_rms_px=m.get('fit_rms_px'),
                       flags='|'.join(map(str, s.get('flags') or [])))
            row.update({f'flux_{b}': v for b, v in (s.get('flux') or {}).items()})
            row.update(label_catalogues='|'.join(c.get('cat', '?') if isinstance(c, dict) else str(c)
                                                 for c in s.get('crossmatch') or []),
                       label_rule_class=s.get('class'), label_appearance=s.get('appearance_class'),
                       spectrum=json.dumps(s.get('spectrum')), light_curve=json.dumps(s.get('light_curve')))
            rows.append(row)
    if not rows:
        return print('no reports yet')
    keys = sorted({k for r in rows for k in r}, key=lambda k: (k.startswith(('label', 'spectrum', 'light')), k))
    with (OUT / 'sources.csv').open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)
    print(f"{len(rows)} sources from {len({r['zone'] for r in rows})} zones -> {OUT / 'sources.csv'}")


if __name__ == '__main__':
    {'zones': make_zones, 'run': run, 'table': table}[sys.argv[1]]()
