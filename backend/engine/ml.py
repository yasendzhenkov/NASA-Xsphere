"""Second opinion from the team's trained triage model (processing/dataset/train.py) on every zone-report source.

Adds ml_class, ml_confidence, ml_oddness and ml_oddness_top_pct (rank within this report) to each source, plus
report['ml'] = the model's honest test numbers from models/metrics.json. The rule-based `class` is never changed.
Model: models/spherex-triage.joblib (in the repo, no network); fallback Hugging Face YasenDzhenkov/spherex-triage.
If neither loads, reports pass through unchanged: the model must never break a scan.
"""
import json, logging
import numpy as np
from . import config

MODELS = config.ROOT / 'models'
log = logging.getLogger(__name__)


def _load():
    try:
        import joblib
        return joblib.load(MODELS / 'spherex-triage.joblib')
    except Exception as e:
        log.warning('triage model: local file not loaded (%s); trying Hugging Face', e)
    try:
        import skops.io as sio
        from huggingface_hub import hf_hub_download
        p = hf_hub_download('YasenDzhenkov/spherex-triage', 'spherex-triage.skops')
        return sio.load(p, trusted=sio.get_untrusted_types(file=p))
    except Exception as e:
        log.warning('triage model unavailable (%s): reports go out without ml_* fields', e)
        return None


def _info():
    try:
        m = json.loads((MODELS / 'metrics.json').read_text())
        return dict(n_sources=m['n_sources'], n_zones=m['n_zones'], accuracy=m['accuracy'], test=m.get('test'),
                    baseline_accuracy=m['baseline_always_majority']['accuracy'], baseline_class=m['baseline_always_majority']['cls'])
    except Exception:
        return {}


MODEL = _load()   # once, at engine start-up
INFO = _info()


def annotate(report: dict, model=None) -> dict:
    m = model or MODEL
    src = report.get('sources') or []
    if not m or not src:
        return report
    try:
        from processing.dataset.train import features   # the exact training features
        X = np.array([features(s) for s in src], float)
        proba = m['classifier'].predict_proba(X)
        odd = -m['novelty'].score_samples(np.nan_to_num(X, nan=-9))
        classes = m['classifier'].classes_
        for s, p, o in zip(src, proba, odd):
            s.update(ml_class=str(classes[p.argmax()]), ml_confidence=round(float(p.max()), 3), ml_oddness=round(float(o), 4),
                     ml_oddness_top_pct=max(1, round(100 * float((odd >= o).mean()))))
        report['ml'] = INFO
    except Exception as e:
        log.warning('triage model skipped on this report: %s', e)
    return report


if __name__ == '__main__':   # self-check, from the repo root:  PYTHONPATH=backend python -m engine.ml <report.json>
    import sys
    r = annotate(json.loads(open(sys.argv[1]).read()))
    s = r['sources']
    assert all({'ml_class', 'ml_confidence', 'ml_oddness'} <= x.keys() for x in s), 'ml fields missing'
    assert all(0 <= x['ml_confidence'] <= 1 and 1 <= x['ml_oddness_top_pct'] <= 100 for x in s)
    assert annotate({'sources': [{'id': 'x'}]}, model={'classifier': None})['sources'][0].keys() == {'id'}   # bad model: no crash
    for x in sorted(s, key=lambda x: -x['ml_oddness'])[:5]:
        print(x['id'], x['class'], '->', x['ml_class'], f"{x['ml_confidence']:.0%}", f"top {x['ml_oddness_top_pct']} %")
    print('ml selftest ok', r['ml'])
