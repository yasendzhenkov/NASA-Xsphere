"""Frame engine (P1): exposures -> per-epoch co-adds on one common grid.

For every exposure: read only a small section from the public S3 file, subtract ZODI and a residual
background, mask bad pixels, reproject onto the common north-up grid (D7). Then inverse-variance co-add
per epoch. Returns float arrays in FITS orientation (row 0 = south); export.py flips them for the web.
"""
import hashlib
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord, Distance
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.time import Time
from astropy.wcs import WCS, FITSFixedWarning
from reproject import reproject_interp

from .config import CFG, ROOT

warnings.simplefilter("ignore", FITSFixedWarning)
warnings.filterwarnings("ignore", category=RuntimeWarning)
from astropy.utils.exceptions import AstropyUserWarning
warnings.simplefilter("ignore", AstropyUserWarning)
from astropy import log as _alog
_alog.setLevel("ERROR")

CACHE = ROOT / CFG["cache_dir"]


def sky_at(target, mjd):
    """Target position at a given MJD (proper motion + parallax distance), D6."""
    c = SkyCoord(ra=target["ra_deg"] * u.deg, dec=target["dec_deg"] * u.deg,
                 pm_ra_cosdec=(target.get("pmra_masyr") or 0) * u.mas / u.yr,
                 pm_dec=(target.get("pmdec_masyr") or 0) * u.mas / u.yr,
                 distance=Distance(parallax=max(target.get("plx_mas") or 0.1, 0.1) * u.mas),
                 obstime=Time(target["ref_epoch"], format="jyear"))
    return c.apply_space_motion(new_obstime=Time(mjd, format="mjd"))


def common_grid(center, nx=None, ny=None, pix_arcsec=None):
    nx = nx or CFG["grid"]["nx"]; ny = ny or CFG["grid"]["ny"]
    pix = (pix_arcsec or CFG["grid"]["pix_arcsec"]) / 3600.0
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [center.ra.deg, center.dec.deg]
    w.wcs.crpix = [(nx + 1) / 2, (ny + 1) / 2]
    w.wcs.cdelt = [-pix, pix]
    return w, (ny, nx)


def _read_section(exp, center, half):
    """Section of IMAGE/FLAGS/VARIANCE/ZODI around `center`, cached on disk."""
    key = hashlib.md5(f"{exp['url']}|{center.ra.deg:.5f}|{center.dec.deg:.5f}|{half}".encode()).hexdigest()
    f = CACHE / f"{key}.npz"
    if f.exists():
        z = np.load(f, allow_pickle=False)
        return {k: z[k] for k in z.files} | {"hdr": fits.Header.fromstring(str(z["hdr_str"]))}
    out = None
    try:   # fast path: only the bytes of the cut (processing/rowread.py), same arrays; astropy below is the fallback
        from . import rowread
        H = rowread.hdus(exp["url"], {"IMAGE", "FLAGS", "VARIANCE", "ZODI"})
        hdr = H["IMAGE"][0]
        x, y = WCS(hdr).world_to_pixel(center)
        xi, yi = int(round(float(x))), int(round(float(y)))
        ny, nx = hdr["NAXIS2"], hdr["NAXIS1"]
        x0, x1 = max(xi - half, 0), min(xi + half + 1, nx)
        y0, y1 = max(yi - half, 0), min(yi + half + 1, ny)
        if x1 - x0 < 8 or y1 - y0 < 8:
            return None
        r, _ = rowread.read(exp["url"], y0, y1, x0, x1, H=H)
        out = {"img": r["IMAGE"].astype(np.float32), "flg": r["FLAGS"].astype(np.int64),
               "var": r["VARIANCE"].astype(np.float32), "zodi": r["ZODI"].astype(np.float32),
               "x0": np.int32(x0), "y0": np.int32(y0)}
    except FileNotFoundError:
        raise
    except Exception:
        out = None
    for attempt in range(0 if out is not None else 4):
        try:
            with fits.open(exp["url"], use_fsspec=True, fsspec_kwargs={"block_size": 512_000}) as h:
                hdr = h["IMAGE"].header
                w = WCS(hdr)
                x, y = w.world_to_pixel(center)
                xi, yi = int(round(float(x))), int(round(float(y)))
                ny, nx = hdr["NAXIS2"], hdr["NAXIS1"]
                x0, x1 = max(xi - half, 0), min(xi + half + 1, nx)
                y0, y1 = max(yi - half, 0), min(yi + half + 1, ny)
                if x1 - x0 < 8 or y1 - y0 < 8:
                    return None
                sl = (slice(y0, y1), slice(x0, x1))
                out = {"img": h["IMAGE"].section[sl].astype(np.float32),
                       "flg": h["FLAGS"].section[sl].astype(np.int64),
                       "var": h["VARIANCE"].section[sl].astype(np.float32),
                       "zodi": h["ZODI"].section[sl].astype(np.float32),
                       "x0": np.int32(x0), "y0": np.int32(y0)}
            break
        except Exception:
            if attempt == 3:
                raise
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(f, hdr_str=np.str_(hdr.tostring()), **out)
    return out | {"hdr": hdr}


def process_exposure(exp, center, grid_wcs, shape, half):
    s = _read_section(exp, center, half)
    if s is None:
        return None
    sh = s["img"].shape
    x0, y0 = int(s["x0"]), int(s["y0"])
    # sub-image WCS: WCS.slice also moves the SIP distortion reference (editing wcs.crpix alone does not)
    w = WCS(s["hdr"]).slice((slice(y0, y0 + sh[0]), slice(x0, x0 + sh[1])))
    img = s["img"] - s["zodi"]
    hard = sum(1 << b for b in CFG["flags"]["hard_mask_bits"])
    sat = sum(1 << b for b in CFG["flags"]["saturation_bits"])
    bad = ((s["flg"] & hard) != 0) | ~np.isfinite(img) | ~np.isfinite(s["var"]) | (s["var"] <= 0)
    img = np.where(bad, np.nan, img)
    _, med, _ = sigma_clipped_stats(img, sigma=3)          # residual background (flat over ~10')
    img = img - med
    var = np.where(bad, np.nan, s["var"])
    satm = ((s["flg"] & sat) != 0).astype(np.float32)
    f, _ = reproject_interp((img, w), grid_wcs, shape_out=shape, order="bilinear")
    v, _ = reproject_interp((var, w), grid_wcs, shape_out=shape, order="bilinear")
    m, _ = reproject_interp((satm, w), grid_wcs, shape_out=shape, order="nearest-neighbor")
    return {"flux": f, "var": v, "sat": np.nan_to_num(m) > 0, "mjd": float(s["hdr"]["MJD-AVG"]),
            "det": exp["det"], "epoch": exp["epoch"], "obs_id": exp["obs_id"]}


def build_frames(target, exps, center=None, workers=8, log=print, nx=None, ny=None, pix_arcsec=None, renumber=True):
    """Returns (grid_wcs, shape, frames) where frames is a list of per-epoch co-adds."""
    mjds = np.array([e["mjd"] for e in exps])
    center = center or sky_at(target, float(mjds.mean()))
    grid_wcs, shape = common_grid(center, nx, ny, pix_arcsec)
    scale = (pix_arcsec or CFG["grid"]["pix_arcsec"]) / CFG["spherex"]["pixel_arcsec"]
    half = int(np.ceil(max(shape) * scale * 0.75)) + 4                 # covers the rotated grid
    log(f"{len(exps)} exposures, grid {shape[1]}x{shape[0]} centred at "
        f"{center.ra.deg:.5f} {center.dec.deg:+.5f}; reading sections from S3 ...")
    done = []
    with ThreadPoolExecutor(workers) as pool:
        futs = [pool.submit(process_exposure, e, center, grid_wcs, shape, half) for e in exps]
        for i, fu in enumerate(futs):
            try:
                r = fu.result()
            except Exception as ex:                                # one bad file never kills the run
                log(f"  skip {exps[i]['obs_id']} {exps[i]['det']}: {ex.__class__.__name__}")
                continue
            if r is not None:
                done.append(r)
    frames = []
    for ep in sorted({d["epoch"] for d in done}):
        grp = [d for d in done if d["epoch"] == ep]
        F = np.stack([g["flux"] for g in grp]); V = np.stack([g["var"] for g in grp])
        W = np.where(np.isfinite(F) & np.isfinite(V) & (V > 0), 1.0 / V, 0.0)
        F0 = np.nan_to_num(F)
        if len(grp) >= 5:                                        # clip outliers (cosmic rays, glints)
            med = np.nanmedian(F, axis=0); mad = np.nanmedian(np.abs(F - med), axis=0) * 1.4826
            W = np.where(np.abs(F0 - med) > 5 * np.maximum(mad, 1e-6) + 0 * med, 0.0, W)
        wsum = W.sum(0)
        flux = np.where(wsum > 0, (W * F0).sum(0) / np.where(wsum > 0, wsum, 1), np.nan)
        err = np.where(wsum > 0, 1 / np.sqrt(np.where(wsum > 0, wsum, 1)), np.nan)
        mjd = float(np.mean([g["mjd"] for g in grp]))
        pos = sky_at(target, mjd)
        tx, ty = grid_wcs.world_to_pixel(pos)
        frames.append({"epoch": int(ep), "mjd": mjd, "n_exposures": len(grp),
                       "dets": sorted({g["det"] for g in grp}),
                       "flux": flux.astype(np.float32), "err": err.astype(np.float32),
                       "nhits": (W > 0).sum(0).astype(np.int16),
                       "sat": np.any([g["sat"] for g in grp], axis=0),
                       "target_fits_px": (float(tx), float(ty)),
                       "target_radec": (pos.ra.deg, pos.dec.deg)})
        log(f"  epoch {ep}: {len(grp)} exposures, {Time(mjd, format='mjd').iso[:10]}")
    # renumber epochs 0..N-1 (some epochs may have no usable exposures in this band)
    if renumber:
        for k, fr in enumerate(frames):
            fr["epoch"] = k
    return grid_wcs, shape, frames
