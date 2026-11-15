"""Zone scan orchestration (chunk A): a drawn box → live photos → I2 stacks (D4/D5/D6) → Quirce's discovery engine
(processing/discovery: detection, motion linking, Gaia/CatWISE/AllWISE/2MASS/SkyBoT cross-match, rules, photometry)
→ I3 report. Classification lives in chunk B only."""
import json, math, traceback
import astropy.units as u
from astropy.coordinates import SkyCoord
from . import inventory, ml, pipeline

def run_scan(job, ra, dec, w_arcmin, h_arcmin, band, per_epoch, classify=True):
    from . import jobs
    from processing.discovery.scan import scan as discover
    try:
        radius = math.hypot(w_arcmin, h_arcmin) / 2 / 60
        job.update(status='listing', progress=0.03)
        rows = inventory.query(ra, dec, radius_deg=radius)
        if not rows:
            raise RuntimeError('outside-coverage: SPHEREx has no photos of this zone yet')
        nx = max(32, int(math.ceil(max(w_arcmin, h_arcmin) * 60 / pipeline.STACK_PIX)))
        job.update(status='fetching', progress=0.08, n_photos_total=len(rows), visits=inventory.summary(rows))
        t = pipeline.field_target(ra, dec, name=f'Zone {ra:.3f} {dec:+.3f}')
        out = jobs.LIVE / job['key']
        z = pipeline.build_zone(t, rows, SkyCoord(ra * u.deg, dec * u.deg), out, nx, per_epoch, log=jobs._log(job))
        if not z or len(z['visits']) < 2:
            raise RuntimeError('outside-coverage: fewer than 2 visits of this zone, nothing to compare')
        job.update(status='checking catalogues', progress=0.8, n_photos_band=z['n_exposures'],
                   bundle=f"/live/{job['key']}/D4/manifest.json" if z['manifest'] else None)
        if not classify:   # photos only: done as soon as the blink bundle exists
            job.update(status='done', progress=1.0, report=None); jobs._save(job); return
        report = json.loads(json.dumps(discover(z['stacks_dir'], log=jobs._log(job)), default=float))
        ml.annotate(report)   # second opinion from the trained triage model; rule-based class unchanged
        report.update(photos_used=z['n_exposures'], photos_available=len(rows), bundle=job.get('bundle'))
        (out / 'report.json').write_text(json.dumps(report, indent=1))
        job.update(status='done', progress=1.0, report=report, report_url=f"/live/{job['key']}/report.json")
        jobs._save(job)
    except Exception as e:
        msg = str(e); code = msg.split(':')[0]
        job.update(status='error', error=code if code in ('outside-coverage', 'nasa-busy') else 'internal', message=msg,
                   trace=traceback.format_exc()[-1500:])
