"""Exact-byte section reader for uncompressed SPHEREx FITS on S3.

astropy+fsspec reads whole 512 KB blocks, i.e. full detector rows (2040 px) for a ~200 px wide cut: ~10x the bytes.
Here: parse the HDU headers once, then fetch only the needed span of every row, many small HTTP range requests
in parallel. Same arrays as `h[NAME].section[y0:y1, x0:x1]`. Returns None for a compressed/unknown layout, so the
caller falls back to astropy.
"""
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from astropy.io import fits

POOL = ThreadPoolExecutor(96)
_local = threading.local()
BLOCK = 2880


def _session():
    s = getattr(_local, 's', None)
    if s is None:
        s = _local.s = requests.Session()
        s.mount('https://', requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=4, max_retries=3))
    return s


def _get(url, a, b):
    """bytes a..b inclusive."""
    for attempt in range(4):
        try:
            r = _session().get(url, headers={'Range': f'bytes={a}-{b}'}, timeout=30)
            if r.status_code == 404:
                raise FileNotFoundError(url)
            r.raise_for_status()
            return r.content
        except FileNotFoundError:
            raise
        except Exception:
            if attempt == 3:
                raise


def hdus(url, want):
    """{EXTNAME: (header, data_offset)} for the wanted extensions, walking headers with small reads."""
    out, off, buf, buf0 = {}, 0, b'', 0
    while len(out) < len(want):
        hb = b''
        while True:   # read header blocks until END
            need = off + len(hb) + BLOCK
            if need > buf0 + len(buf):
                buf0, buf = off + len(hb), _get(url, off + len(hb), off + len(hb) + 12 * BLOCK - 1)
            blk = buf[off + len(hb) - buf0: off + len(hb) - buf0 + BLOCK]
            if len(blk) < BLOCK:
                return out   # end of file
            hb += blk
            if any(blk[i:i + 8] == b'END     ' for i in range(0, BLOCK, 80)):
                break
        h = fits.Header.fromstring(hb.decode('ascii', 'replace'))
        data = off + len(hb)
        n = abs(h.get('BITPIX', 8)) // 8
        for i in range(1, h.get('NAXIS', 0) + 1):
            n *= h.get(f'NAXIS{i}', 0)
        n *= 1 if h.get('NAXIS', 0) else 0
        name = h.get('EXTNAME')
        if name in want:
            out[name] = (h, data)
        off = data + (n + h.get('PCOUNT', 0) + BLOCK - 1) // BLOCK * BLOCK
    return out


DT = {8: 'u1', 16: '>i2', 32: '>i4', 64: '>i8', -32: '>f4', -64: '>f8'}


def section(url, h, data, y0, y1, x0, x1):
    nx, bpp = h['NAXIS1'], abs(h['BITPIX']) // 8
    rows = list(POOL.map(lambda y: _get(url, data + (y * nx + x0) * bpp, data + (y * nx + x1) * bpp - 1), range(y0, y1)))
    a = np.frombuffer(b''.join(rows), dtype=DT[h['BITPIX']]).reshape(y1 - y0, x1 - x0)
    if 'BSCALE' in h or 'BZERO' in h:
        a = a * h.get('BSCALE', 1) + h.get('BZERO', 0)
    return a


def rice_section(url, h, data, y0, y1, x0, x1):
    """Tile-compressed (RICE_1, one tile per row) HDU: fetch only rows y0..y1 of the heap, decompress, cut columns."""
    from astropy.io.fits.hdu.compressed._codecs import Rice1
    assert h.get('ZCMPTYPE') == 'RICE_1' and h.get('ZTILE1') == h['ZNAXIS1'] and h.get('ZTILE2', 1) == 1
    assert h['TFORM1'].startswith('1P') and h['NAXIS1'] == 8
    desc = np.frombuffer(_get(url, data + 8 * y0, data + 8 * y1 - 1), dtype='>i4').reshape(-1, 2)
    heap = data + h.get('THEAP', h['NAXIS1'] * h['NAXIS2'])
    a, b = int(desc[:, 1].min()), int((desc[:, 1] + desc[:, 0]).max())
    step = 128 * 1024   # heap span in parallel chunks
    blob = b''.join(POOL.map(lambda s: _get(url, heap + s, heap + min(s + step, b) - 1), range(a, b, step)))
    bp = {k: h[v] for k, v in (('blocksize', 'ZVAL1'), ('bytepix', 'ZVAL2'))} if h.get('ZNAME1') == 'BLOCKSIZE' else dict(blocksize=32, bytepix=4)
    codec = Rice1(tilesize=h['ZNAXIS1'], **bp)
    rows = [np.frombuffer(codec.decode(np.frombuffer(blob[o - a:o - a + n], dtype=np.uint8)), dtype=f"i{bp['bytepix']}")[:h['ZNAXIS1']][x0:x1] for n, o in desc]
    return np.stack(rows)


def read(url, y0, y1, x0, x1, names=('IMAGE', 'FLAGS', 'VARIANCE', 'ZODI'), H=None):
    H = H or hdus(url, set(names))
    out = {}
    for k in names:
        h, d = H[k]
        out[k] = rice_section(url, h, d, y0, y1, x0, x1) if h.get('XTENSION') == 'BINTABLE' else section(url, h, d, y0, y1, x0, x1)
    return out, H
