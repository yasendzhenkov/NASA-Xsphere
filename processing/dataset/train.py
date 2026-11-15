"""Train + test the open SPHEREx classifier on the collector's zone reports (ml-plan.md).

  python -m processing.dataset.train            # features + labels -> grouped CV test -> final model + metrics
  python -m processing.dataset.train --selftest

Input features are SPHEREx-only (brightness in D4/D5/D6, colours, change across visits, motion).
Labels come only from catalogue matches (Gaia DR3, CatWISE/AllWISE, SkyBoT), never used as inputs (no answer leakage).
Test = whole zones held out (GroupKFold), so the model is scored on sky it never saw.
"""
import json, sys
from pathlib import Path
import numpy as np

OUT = Path(__file__).resolve().parents[2] / 'cache' / 'ml-dataset'
SHOWCASE = Path(__file__).resolve().parents[1] / 'discovery' / 'reports'
BANDS = ('D4', 'D5', 'D6')
FEATURES = ([f'logflux_{b}' for b in BANDS] + [f'change_{b}' for b in BANDS] + [f'nvalid_{b}' for b in BANDS]
            + ['colour_45', 'colour_56', 'speed_arcsec_yr', 'motion_sig', 'fit_rms_px', 'n_visits', 'single_visit', 'saturated'])
CLASSES = ['star', 'ir-only', 'asteroid', 'unmatched']


def label(xm):
    """Catalogue answer: Gaia within 2" = star; WISE within 3" and no Gaia = ir-only (galaxies, dusty or cool objects)."""
    near = lambda pre, r: any(c.get('cat', '').startswith(pre) and (c.get('sep_arcsec') or 99) <= r for c in xm or [])
    if near('SkyBoT', 10) or any('asteroid' in str(c.get('cat', '')).lower() for c in xm or []):
        return 'asteroid'
    if near('Gaia', 2):
        return 'star'
    if near('CatWISE', 3) or near('AllWISE', 3):
        return 'ir-only'
    return 'unmatched'


def features(s):
    f = {}
    meds = {}
    for b in BANDS:
        v = np.array([x for x in (s.get('flux') or {}).get(b, []) if x is not None], float)
        med = float(np.median(v)) if len(v) else np.nan
        meds[b] = med
        f[f'logflux_{b}'] = np.log10(med) if med > 0 else np.nan
        f[f'change_{b}'] = float(np.std(v) / abs(med)) if len(v) > 1 and med else np.nan
        f[f'nvalid_{b}'] = len(v)
    lr = lambda a, b: np.log10(a / b) if a > 0 and b > 0 else np.nan
    f['colour_45'], f['colour_56'] = lr(meds['D4'], meds['D5']), lr(meds['D5'], meds['D6'])
    m = s.get('motion') or {}
    f['speed_arcsec_yr'] = m.get('speed_arcsec_yr', np.nan)
    f['motion_sig'] = m.get('sig', np.nan)
    f['fit_rms_px'] = m.get('fit_rms_px', np.nan)
    f['n_visits'] = m.get('n_visits', 1)
    f['single_visit'] = int('single-visit' in (s.get('flags') or []))
    f['saturated'] = int('saturated-core' in (s.get('flags') or []))
    return [float(f[k]) if f[k] is not None else np.nan for k in FEATURES]


def load(paths):
    X, y, g, ids = [], [], [], []
    for p in paths:
        d = json.loads(p.read_text())
        rep = d.get('report', d)
        src = (rep.get('method') or {}).get('catalog_sources') or {}
        if any(src.get(c) == 'unavailable' for c in ('Gaia DR3', 'AllWISE')):
            print('skip', p.stem, '(label catalogue unavailable: labels would be wrong)'); continue
        zone = d.get('zone', {}).get('id', p.stem)
        for s in rep.get('sources', []):
            X.append(features(s)); y.append(label(s.get('crossmatch'))); g.append(zone); ids.append(f"{zone}/{s['id']}")
    return np.array(X, float), np.array(y), np.array(g), ids


def main():
    from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest
    from sklearn.model_selection import GroupKFold
    from sklearn.metrics import classification_report, confusion_matrix, balanced_accuracy_score, accuracy_score
    import joblib

    paths = sorted((OUT / 'reports').glob('[A-Z][0-9]*[0-9].json'))
    X, y, g, ids = load(paths)
    zones = sorted(set(g))
    print(f'{len(y)} sources from {len(zones)} zones; labels:', {c: int((y == c).sum()) for c in CLASSES})
    if len(zones) < 2:
        return print('need at least 2 zones to test on held-out sky')

    mk = lambda: HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, class_weight='balanced', random_state=0)
    pred = np.empty_like(y)
    folds = GroupKFold(n_splits=min(5, len(zones)))
    for tr, te in folds.split(X, y, g):
        pred[te] = mk().fit(X[tr], y[tr]).predict(X[te])
    labels = [c for c in CLASSES if (y == c).any()]
    major = max(labels, key=lambda c: (y == c).sum())
    metrics = dict(
        n_sources=int(len(y)), n_zones=len(zones), zones=zones, test='GroupKFold by zone (held-out sky)',
        label_counts={c: int((y == c).sum()) for c in CLASSES},
        accuracy=round(accuracy_score(y, pred), 3), balanced_accuracy=round(balanced_accuracy_score(y, pred), 3),
        baseline_always_majority=dict(cls=major, accuracy=round(float((y == major).mean()), 3), balanced_accuracy=round(1 / len(labels), 3)),
        per_class=classification_report(y, pred, labels=labels, output_dict=True, zero_division=0),
        confusion=dict(labels=labels, matrix=confusion_matrix(y, pred, labels=labels).tolist()),
        features=FEATURES)
    print(classification_report(y, pred, labels=labels, zero_division=0))
    print('confusion (rows = catalogue truth):', labels); print(confusion_matrix(y, pred, labels=labels))

    # "fits nothing known": anomaly score learnt on catalogued sources only
    Xi = np.nan_to_num(X, nan=-9)
    known = y != 'unmatched'
    iso = IsolationForest(n_estimators=300, contamination='auto', random_state=0).fit(Xi[known])
    odd = -iso.score_samples(Xi)
    top = odd >= np.quantile(odd, 0.95)
    metrics['novelty'] = dict(top5pct_unmatched_share=round(float((y[top] == 'unmatched').mean()), 3),
                              base_unmatched_share=round(float((y == 'unmatched').mean()), 3))
    print('novelty: unmatched share in top 5 % oddest', metrics['novelty'])

    model = mk().fit(X, y)
    (OUT / 'model').mkdir(exist_ok=True)
    joblib.dump(dict(classifier=model, novelty=iso, features=FEATURES, classes=list(model.classes_)), OUT / 'model' / 'spherex-triage.joblib')
    (OUT / 'model' / 'metrics.json').write_text(json.dumps(metrics, indent=1))
    with (OUT / 'model' / 'test_predictions.csv').open('w') as f:
        f.write('source,catalogue_truth,predicted_held_out,oddness\n')
        f.writelines(f'{i},{a},{b},{o:.3f}\n' for i, a, b, o in zip(ids, y, pred, odd))

    # showcase: the app's named targets, never in training
    sc = sorted(SHOWCASE.glob('*.json'))
    if sc:
        Xs, ys, gs, idss = load(sc)
        ps, pp = model.predict(Xs), model.predict_proba(Xs).max(1)
        os_ = -iso.score_samples(np.nan_to_num(Xs, nan=-9))
        rows = [dict(source=i, truth=t, predicted=p, confidence=round(float(c), 2), odd_percentile=round(float((odd < o).mean() * 100)))
                for i, t, p, c, o in zip(idss, ys, ps, pp, os_)]
        metrics['showcase'] = dict(n=len(rows), accuracy=round(float((ys == ps).mean()), 3))
        (OUT / 'model' / 'showcase.json').write_text(json.dumps(rows, indent=1))
        (OUT / 'model' / 'metrics.json').write_text(json.dumps(metrics, indent=1))
        print('showcase targets:', metrics['showcase'])
    print('saved ->', OUT / 'model')
    print(f"SUMMARY zones={len(zones)} sources={len(y)} held-out accuracy={metrics['accuracy']} balanced={metrics['balanced_accuracy']} "
          f"(always-guess-{major}: {metrics['baseline_always_majority']['accuracy']})")


def selftest():
    assert label([{'cat': 'Gaia DR3', 'sep_arcsec': 0.5}]) == 'star'
    assert label([{'cat': 'Gaia DR3', 'sep_arcsec': 5}, {'cat': 'CatWISE2020', 'sep_arcsec': 1}]) == 'ir-only'
    assert label([{'cat': 'AllWISE', 'sep_arcsec': 40}]) == 'unmatched'
    assert label([]) == 'unmatched'
    v = features({'flux': {'D4': [10, 10], 'D5': [5, None], 'D6': []}, 'flags': ['single-visit']})
    f = dict(zip(FEATURES, v))
    assert f['logflux_D4'] == 1 and f['change_D4'] == 0 and np.isnan(f['logflux_D6']) and f['single_visit'] == 1
    assert abs(f['colour_45'] - np.log10(2)) < 1e-9
    print('selftest ok')


if __name__ == '__main__':
    selftest() if '--selftest' in sys.argv else main()
