"""Photo index built straight from NASA's public S3 copy of SPHEREx — the fallback when IRSA's SIA service is down.

IRSA (irsa.ipac.caltech.edu) answers "which photos cover this point?". When it returns 502 the app could not open any
new spot, although the photos themselves (S3 bucket nasa-irsa-spherex) were fine. This module reads the IMAGE header
of every level-2 photo (one 40 kB byte-range read each: pointing WCS + MJD-AVG), keeps it in a small npz, and answers
the same question offline. D4/D5/D6 look at the same sky as D1/D2/D3 (dichroic; measured offset < 0.02°), so only
D1–D3 headers are read and reused.

Build / update (resumable; only new photos are read):   cd backend && python -m engine.s3index build
Ask:                                                     python -m engine.s3index query 269.45 4.77
"""
import asyncio, json, re, sys, time
import numpy as np
from . import config

BUCKET = 'https://nasa-irsa-spherex.s3.amazonaws.com/'
RELEASES = ['dr1', 'qr3']                     # same releases as config.yaml (QR2 excluded, D3)
DIR = config.CACHE / 's3index'
NPX = 2040
# header reads go over plain HTTP: public data, and TLS handshakes (truststore) made the build CPU-bound
HEADER_BASE = 'http://nasa-irsa-spherex.s3.amazonaws.com/'
_mem = None


# ---------- listing ----------
def _list_keys():
    import requests, concurrent.futures as cf
    s = requests.Session()

    def page(prefix, delim, tok=None):
        p = {'list-type': '2', 'prefix': prefix}
        if delim: p['delimiter'] = '/'
        if tok: p['continuation-token'] = tok
        for a in range(5):
            try:
                return s.get(BUCKET, params=p, timeout=60).text
            except Exception:
                time.sleep(2 * (a + 1))
        raise RuntimeError('S3 listing failed')

    def keys(prefix):
        out, tok = [], None
        while True:
            x = page(prefix, False, tok)
            out += [k for k, size in re.findall(r'<Key>([^<]*)</Key>.*?<Size>(\d+)</Size>', x)
                    if k.endswith('.fits') and int(size) > 10_000_000]
            m = re.search(r'<NextContinuationToken>([^<]*)', x)
            if not m: return out
            tok = m.group(1)

    weeks = [w for r in RELEASES for w in re.findall(r'<Prefix>([^<]*)</Prefix>', page(f'{r}/level2/', True))[1:]]
    with cf.ThreadPoolExecutor(32) as ex:
        return [k for ks in ex.map(keys, weeks) for k in ks]


_RX = re.compile(r'level2_(\d{4}W\d+_\w+?_\d{4}_\d+)D(\d)_spx_(l2b(?:_retry)?)-v(\d+)-(\d{4})-(\d{3})\.fits$')


def _dedupe(keys):
    """One file per (exposure, detector): the newest processing (version, then date) wins, as IRSA serves."""
    best = {}
    for k in keys:
        m = _RX.search(k)
        if not m: continue
        obs, det, _, ver, yr, doy = m.groups()
        rank = (int(ver), int(yr), int(doy))
        if (obs, det) not in best or rank > best[(obs, det)][0]:
            best[(obs, det)] = (rank, k)
    return {od: v[1] for od, v in best.items()}


# ---------- header reads ----------
def _parse(b):
    i = b.find(b"XTENSION= 'IMAGE")
    if i < 0: return None
    vals = {}
    for j in range(i, len(b) - 80, 80):
        card = b[j:j + 80].decode('ascii', 'replace')
        if card.startswith('END '): break
        k = card[:8].strip()
        if k in ('CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2', 'PC1_1', 'PC1_2', 'PC2_1', 'PC2_2', 'CDELT1', 'CDELT2', 'MJD-AVG'):
            try: vals[k] = float(card[10:].split('/')[0])
            except ValueError: pass
    need = ('CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2', 'PC1_1', 'PC2_2', 'CDELT1', 'CDELT2', 'MJD-AVG')
    if any(k not in vals for k in need): return None
    c1, c2 = vals['CDELT1'], vals['CDELT2']
    return [vals['CRVAL1'], vals['CRVAL2'], vals['CRPIX1'], vals['CRPIX2'],
            vals['PC1_1'] * c1, vals.get('PC1_2', 0) * c1, vals.get('PC2_1', 0) * c2, vals['PC2_2'] * c2, vals['MJD-AVG']]


async def _read_all(keys, conc=512, log=print):
    import aiohttp
    out = [None] * len(keys)
    sem = asyncio.Semaphore(conc)
    done = 0; t0 = time.time()

    async def one(sess, i, k):
        nonlocal done
        async with sem:
            for a in range(4):
                try:
                    async with sess.get(HEADER_BASE + k, headers={'Range': 'bytes=0-40319'}, timeout=aiohttp.ClientTimeout(total=60)) as r:
                        out[i] = _parse(await r.read()); break
                except Exception:
                    await asyncio.sleep(1 + 2 * a)
            done += 1
            if done % 20000 == 0:
                log(f'  {done}/{len(keys)} headers, {done / (time.time() - t0):.0f}/s', flush=True)

    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=conc)) as sess:
        await asyncio.gather(*(one(sess, i, k) for i, k in enumerate(keys)))
    return out


def build(chunk=50000, log=print):
    DIR.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    files = _dedupe(_list_keys())
    log(f'{len(files)} photos on S3 ({time.time() - t0:.0f}s)', flush=True)
    known = set()
    for p in sorted(DIR.glob('part-*.json')):
        known |= {k for k, _ in json.loads(p.read_text())}
    todo = sorted(k for (obs, det), k in files.items() if det in '123' and k not in known)
    log(f'{len(todo)} headers to read (D1-D3; D4-D6 reuse them)', flush=True)
    n0 = len(list(DIR.glob('part-*.json')))
    for c in range(0, len(todo), chunk):
        ks = todo[c:c + chunk]
        hs = asyncio.run(_read_all(ks, log=log))
        (DIR / f'part-{n0 + c // chunk:04d}.json').write_text(json.dumps([[k, h] for k, h in zip(ks, hs) if h]))
        log(f'part {c // chunk}: {sum(h is not None for h in hs)}/{len(ks)} ok, {time.time() - t0:.0f}s', flush=True)
    consolidate(files, log)


def consolidate(files=None, log=print):
    """Merge parts into index.npz; add D4-D6 rows from D1-D3 headers of the same exposure.
    Stored compactly: exposure id (bytes) + detector + index into a small table of '<release>/<processing dir>'."""
    rows = {}
    for p in sorted(DIR.glob('part-*.json')):
        for k, h in json.loads(p.read_text()):
            rows[_RX.search(k).group(1, 2)] = (k, h)
    files = files or {}
    vds, vdi = [], {}
    def vd(k):
        s = k.split('/')[0] + '/' + k.split('/')[3]
        if s not in vdi: vdi[s] = len(vds); vds.append(s)
        return vdi[s]
    obs, det, V, H = [], [], [], []
    for (o, d), (k, h) in rows.items():
        d2 = str(int(d) + 3)
        for dd, kk in ((d, k), (d2, files.get((o, d2), k))):
            obs.append(o); det.append(int(dd)); V.append(vd(kk)); H.append(h)
    np.savez_compressed(DIR / 'index.npz', obs=np.array(obs, dtype='S24'), det=np.array(det, dtype=np.int8),
                        vd=np.array(V, dtype=np.int32), vds=np.array(vds), h=np.array(H, dtype=np.float64))
    (DIR / 'built.txt').write_text(time.strftime('%Y-%m-%d %H:%M'))
    global _mem; _mem = None
    log(f'index: {len(obs)} photos', flush=True)


def _key(obs, det, vd):
    rel, pdir = vd.split('/')
    return f'{rel}/level2/{obs.rsplit('_', 2)[0]}/{pdir}/{det}/level2_{obs}D{det}_spx_{pdir}.fits'


# ---------- query ----------
def available():
    return (DIR / 'index.npz').exists()


def _load():
    global _mem
    if _mem is None:
        z = np.load(DIR / 'index.npz')
        h = z['h']
        ra, dec = np.radians(h[:, 0]), np.radians(h[:, 1])
        _mem = dict(obs=z['obs'], det=z['det'], vd=z['vd'], vds=z['vds'], h=h,
                    xyz=np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], 1))
    return _mem


def query(ra, dec, radius_deg=0.0003):
    """Same rows as inventory.query (without visits): photos whose footprint contains the point (± radius)."""
    m = _load()
    a, d = np.radians(ra), np.radians(dec)
    p = np.array([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)])
    near = np.nonzero(m['xyz'] @ p > np.cos(np.radians(2.6 + radius_deg)))[0]   # detector half-diagonal ≈ 2.47°
    h = m['h'][near]
    # gnomonic projection about each photo's CRVAL, then CD⁻¹ → pixel (SIP ignored: < 2 px at the edge)
    a0, d0 = np.radians(h[:, 0]), np.radians(h[:, 1])
    cosc = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    xi = np.degrees(np.cos(d) * np.sin(a - a0) / cosc)
    eta = np.degrees((np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / cosc)
    det = h[:, 4] * h[:, 7] - h[:, 5] * h[:, 6]
    x = (h[:, 7] * xi - h[:, 5] * eta) / det + h[:, 2]
    y = (-h[:, 6] * xi + h[:, 4] * eta) / det + h[:, 3]
    mpx = radius_deg / 0.00171
    ok = (cosc > 0) & (x > 0.5 - mpx) & (x < NPX + 0.5 + mpx) & (y > 0.5 - mpx) & (y < NPX + 0.5 + mpx)
    rows = []
    for i in near[ok]:
        o, dt, v = m['obs'][i].decode(), int(m['det'][i]), str(m['vds'][m['vd'][i]])
        k = _key(o, dt, v); rel = v.split('/')[0]
        rows.append(dict(obs_id=o, band=f'D{dt}', mjd=float(m['h'][i, 8]),
                         collection=f'spherex_{rel}', https=config.IRSA + 'ibe/data/spherex/' + k, s3=config.S3_BASE + k))
    return rows


def footprints(rows, limit=1000):
    """Sky outline of every exposure in `rows` (all three D1-D3 detectors, i.e. the whole 3.5° x 11.3° shot; D4-D6
    see the same sky), from each photo's header WCS: pixel corners -> CD -> inverse gnomonic. SIP ignored (< 2 px)."""
    if not rows or not available():
        return []
    import datetime
    m = _load()
    visit = {r['obs_id']: r.get('visit', 0) for r in rows}
    idx = np.nonzero(np.isin(m['obs'], np.array(sorted(visit), dtype='S24')) & (m['det'] <= 3))[0]
    if len(idx) > limit:   # keep the grid readable and the job JSON small
        idx = idx[np.linspace(0, len(idx) - 1, limit).astype(int)]
    h = m['h'][idx]
    out = []
    for i, hh in zip(idx, h):
        a0, d0 = np.radians(hh[0]), np.radians(hh[1])
        cs = []
        for px, py in ((0.5, 0.5), (NPX + 0.5, 0.5), (NPX + 0.5, NPX + 0.5), (0.5, NPX + 0.5)):
            dx, dy = px - hh[2], py - hh[3]
            xi, eta = np.radians(hh[4] * dx + hh[5] * dy), np.radians(hh[6] * dx + hh[7] * dy)
            den = np.cos(d0) - eta * np.sin(d0)
            ra = np.degrees(a0 + np.arctan2(xi, den)) % 360
            dec = np.degrees(np.arctan2(np.sin(d0) + eta * np.cos(d0), np.hypot(xi, den)))
            cs.append([round(float(ra), 4), round(float(dec), 4)])
        o = m['obs'][i].decode()
        out.append(dict(visit=visit[o], detector=int(m['det'][i]), corners=cs,
                        date=(datetime.datetime(1858, 11, 17) + datetime.timedelta(days=float(hh[8]))).date().isoformat()))
    return out


if __name__ == '__main__':
    if sys.argv[1:2] == ['build']:
        build()
    elif sys.argv[1:2] == ['consolidate']:
        consolidate()
    elif sys.argv[1:2] == ['query']:
        r = query(float(sys.argv[2]), float(sys.argv[3]))
        print(len(r), 'photos'); [print(x['obs_id'], x['band'], round(x['mjd'], 3)) for x in r[:10]]
