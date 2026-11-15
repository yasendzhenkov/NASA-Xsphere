"""Build the two Hugging Face folders from the trained model (run after train.py).

  python -m processing.dataset.package      # -> cache/ml-dataset/hf/model and cache/ml-dataset/hf/data
"""
import csv, inspect, json, shutil
from pathlib import Path

import joblib
import pandas as pd

from . import train as T

OUT = T.OUT / 'hf'
MODEL_REPO, DATA_REPO = 'spherex-triage', 'spherex-triage-data'


def card_model(m, user):
    pc = m['per_class']
    rows = '\n'.join(f"| {c} | {pc[c]['precision']:.2f} | {pc[c]['recall']:.2f} | {int(pc[c]['support'])} |"
                     for c in m['confusion']['labels'])
    cm = m['confusion']
    cmt = '| truth \\ predicted | ' + ' | '.join(cm['labels']) + ' |\n|' + '---|' * (len(cm['labels']) + 1) + '\n' + '\n'.join(
        f"| {a} | " + ' | '.join(str(x) for x in row) + ' |' for a, row in zip(cm['labels'], cm['matrix']))
    sc = m.get('showcase', {})
    return f"""---
library_name: sklearn
license: apache-2.0
tags: [astronomy, spherex, infrared, tabular-classification, anomaly-detection, sklearn]
datasets: [{user}/{DATA_REPO}]
pipeline_tag: tabular-classification
---

# SPHEREx triage: find, explore and identify objects in NASA SPHEREx data

An open classifier for every object that NASA's SPHEREx telescope detects in a patch of sky. For each object it gives
**what it most looks like**, **how sure it is**, and **how much it fits nothing known**, so unusual objects can be checked first.
Built by team **Aphelion** for NASA Space Apps 2026.

## What goes in, what comes out
- **Input: SPHEREx only.** Brightness in the D4/D5/D6 infrared bands across every visit, its colours, how much it changes
  between visits, and how it moves ({len(m['features'])} numbers, listed in `features.json`).
- **Output:** one of `star`, `ir-only` (seen by WISE but not Gaia: galaxies, dusty or cool objects), `asteroid`, `unmatched`
  (a one-off detection, an artefact, or something new), plus an *oddness* score from an Isolation Forest.

## How it was trained
- **Data:** {m['n_sources']} objects from {m['n_zones']} sky zones (10′ each), measured by our open engine straight from
  NASA's public SPHEREx photos on AWS. Dataset: [{user}/{DATA_REPO}](https://huggingface.co/datasets/{user}/{DATA_REPO}).
- **Labels:** catalogue matches only (Gaia DR3 within 2″ = star; AllWISE within 3″ and no Gaia = ir-only; SkyBoT = asteroid;
  nothing = unmatched). Catalogues are used as the answer key, **never as inputs**, so the model cannot copy the answer.
- **Model:** scikit-learn HistGradientBoostingClassifier (balanced class weights) + IsolationForest fitted on catalogued objects.

## How it was tested
Whole zones held out ({m['test']}): the model is always scored on sky it never saw.

| | value |
|---|---|
| accuracy on held-out sky | **{m['accuracy']:.1%}** |
| balanced accuracy (mean of per-class recall) | {m['balanced_accuracy']:.1%} |
| baseline: always guess `{m['baseline_always_majority']['cls']}` | {m['baseline_always_majority']['accuracy']:.1%} |
| oddness: share of `unmatched` among the 5 % oddest | {m['novelty']['top5pct_unmatched_share']:.1%} (base rate {m['novelty']['base_unmatched_share']:.1%}) |
| the app's {sc.get('n', 0)} objects around 6 named targets (never trained on) | {sc.get('accuracy', 0):.1%} |

| class | precision | recall | objects |
|---|---|---|---|
{rows}

{cmt}

## Limits (read before using)
- `unmatched` objects are mostly single-visit detections, which are easy to separate; the hard, useful split is among objects seen on several visits.
- `ir-only` has few examples, and is the weakest class.
- No brown-dwarf, variable-star or young-star classes yet: their labels need SIMBAD, which was down while we built this.
- Photos up to Feb 2026 only (our own S3 header index; NASA's IRSA search was returning errors).
- A label is a catalogue match, not ground truth: faint stars missing from Gaia are labelled `ir-only` or `unmatched`.

## Use
```python
python predict.py report.json      # a zone report from the app's engine (POST /scan → report)
```

## Credits
SPHEREx data: NASA/JPL-Caltech/IPAC (IRSA). Gaia DR3: ESA/Gaia/DPAC. AllWISE and 2MASS: NASA/IPAC. Catalogue access via the
VizieR service (CDS, Strasbourg; Harvard mirror). Asteroids: SkyBoT (IMCCE).
"""


def card_data(n, nz, user):
    return f"""---
license: cc-by-4.0
tags: [astronomy, spherex, infrared, tabular]
pretty_name: SPHEREx triage training set
size_categories: [1K<n<10K]
---

# SPHEREx triage training set

{n} objects detected in {nz} sky zones of NASA SPHEREx photos (D4/D5/D6 bands, all visits up to Feb 2026), each with:
- **SPHEREx features** (`logflux_*`, `change_*`, `nvalid_*`, `colour_*`, motion columns): what the model sees;
- **`label`**: the catalogue answer (Gaia DR3 / AllWISE / SkyBoT), kept apart from the features;
- `spectrum`, `light_curve`: raw per-visit measurements (JSON) for anyone who wants to build richer models.

`zones.csv` lists the zones (random sky positions with ≥3 SPHEREx visits). Model: [{user}/{MODEL_REPO}](https://huggingface.co/{user}/{MODEL_REPO}).

Credits: SPHEREx data NASA/JPL-Caltech/IPAC; Gaia DR3 ESA/Gaia/DPAC (please cite Gaia Collaboration 2023); AllWISE/2MASS NASA/IPAC;
VizieR (CDS); SkyBoT (IMCCE). Built by team Aphelion, NASA Space Apps 2026.
"""


PREDICT = '''"""Classify every object in a SPHEREx zone report:  python predict.py report.json"""
import json, sys
import numpy as np
import skops.io as sio

{features_src}

FEATURES = {features!r}
BANDS = {bands!r}

m = sio.load("spherex-triage.skops", trusted=sio.get_untrusted_types(file="spherex-triage.skops"))
rep = json.load(open(sys.argv[1]))
rep = rep.get("report", rep)
X = np.array([features(s) for s in rep["sources"]], float)
cls, p = m["classifier"].predict(X), m["classifier"].predict_proba(X).max(1)
odd = -m["novelty"].score_samples(np.nan_to_num(X, nan=-9))
for s, c, q, o in sorted(zip(rep["sources"], cls, p, odd), key=lambda t: -t[3]):
    print(f"{{s['id']}}  {{c:10s}} {{q:4.0%}}  oddness {{o:.3f}}")
'''


def main():
    import skops.io as sio
    user = __import__('huggingface_hub').whoami()['name']
    md = T.OUT / 'model'
    m = json.loads((md / 'metrics.json').read_text())
    bundle = joblib.load(md / 'spherex-triage.joblib')
    mo, do = OUT / 'model', OUT / 'data'
    shutil.rmtree(OUT, ignore_errors=True); mo.mkdir(parents=True); do.mkdir(parents=True)

    sio.dump(dict(classifier=bundle['classifier'], novelty=bundle['novelty']), mo / 'spherex-triage.skops')
    (mo / 'features.json').write_text(json.dumps(dict(features=T.FEATURES, classes=bundle['classes']), indent=1))
    for f in ('metrics.json', 'test_predictions.csv', 'showcase.json'):
        if (md / f).exists(): shutil.copy(md / f, mo / f)
    (mo / 'predict.py').write_text(PREDICT.format(features_src=inspect.getsource(T.features), features=T.FEATURES, bands=T.BANDS))
    (mo / 'README.md').write_text(card_model(m, user))

    rows, zones = [], set()
    for p in sorted((T.OUT / 'reports').glob('[A-Z][0-9]*[0-9].json')):
        d = json.loads(p.read_text()); rep = d['report']
        src = rep.get('method', {}).get('catalog_sources', {})
        if d['zone']['id'] not in m['zones']:   # exactly the zones the saved model was trained on
            continue
        zones.add(d['zone']['id'])
        for s in rep['sources']:
            r = dict(zone=d['zone']['id'], source=s['id'], **dict(zip(T.FEATURES, T.features(s))))
            r.update(label=T.label(s.get('crossmatch')), ra_deg=s['positions'][0]['ra_deg'], dec_deg=s['positions'][0]['dec_deg'],
                     spectrum=json.dumps(s.get('spectrum')), light_curve=json.dumps(s.get('light_curve')))
            rows.append(r)
    pd.DataFrame(rows).to_parquet(do / 'sources.parquet', index=False)
    with (T.OUT / 'zones.csv').open() as f:
        zr = [z for z in csv.DictReader(f) if z['id'] in zones]
    with (do / 'zones.csv').open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(zr[0])); w.writeheader(); w.writerows(zr)
    (do / 'README.md').write_text(card_data(len(rows), len(zones), user))
    assert len(rows) == m['n_sources'], (len(rows), m['n_sources'])   # dataset = exactly what the model was trained on
    print(f'{user}: model -> {mo}, data ({len(rows)} rows, {len(zones)} zones) -> {do}')


if __name__ == '__main__':
    main()
