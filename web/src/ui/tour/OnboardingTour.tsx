import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { STEPS, waitFor, closeStar3D } from './steps';
import './tour.css';

const KEY = 'spherex-blink.tour'; // 'dismissed' | 'done'
const EXPLAINER = 'https://spherex-blink-demo.vercel.app/#explainer';
const readSeen = () => { try { return localStorage.getItem(KEY); } catch { return 'unknown'; } };
const writeSeen = (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* private mode: just don't remember */ } };

type Rect = { x: number; y: number; w: number; h: number };
const PAD = 6;

/** "? Tour" button + first-visit hint + the 14-step spotlight tour (rendered in a portal above everything). */
export function OnboardingTour({ mobile }: { mobile: boolean }) {
  const [step, setStep] = useState(-1); // -1 = closed
  const [hint, setHint] = useState(() => !readSeen());
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [cardH, setCardH] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const dir = useRef(1);
  const run = useRef(0);
  const target = useRef<HTMLElement | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;

  const open = step >= 0;
  const s = open ? STEPS[step] : null;

  const close = useCallback((done: boolean) => {
    run.current++;
    target.current = null;
    setStep(-1);
    setRect(null);
    closeStar3D();
    writeSeen(done ? 'done' : readSeen() ?? 'dismissed');
    btnRef.current?.focus();
  }, []);

  const go = useCallback((i: number) => {
    dir.current = i >= step ? 1 : -1;
    if (i >= STEPS.length) { close(true); return; }
    setStep(Math.max(0, i));
  }, [step, close]);

  const start = () => { setHint(false); writeSeen(readSeen() ?? 'dismissed'); dir.current = 1; setStep(0); };

  // run the step: auto-action, then wait for its target; a missing target skips the step in the direction of travel
  useEffect(() => {
    if (!s) return;
    const ticket = ++run.current;
    target.current = null;
    setRect(null);
    setBusy(Boolean(s.action || s.target));
    (async () => {
      if (!STEPS[step].title.startsWith('View in 3D')) closeStar3D();
      try { await s.action?.({ mobile }); } catch { /* never break the app */ }
      if (ticket !== run.current) return;
      let el: HTMLElement | null = null;
      if (s.target) {
        el = await waitFor(s.target, 4000);
        if (ticket !== run.current) return;
        if (!el) { // target missing: skip gracefully
          const n = step + dir.current;
          if (n < 0 || n >= STEPS.length) setBusy(false); else setStep(n);
          return;
        }
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      target.current = el;
      setBusy(false);
      if (!s.keepFocus) headRef.current?.focus();
    })();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // follow the target while the map animates
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      let el = target.current;
      if (el && !el.isConnected) { // React re-rendered the control: find its replacement
        const sel = STEPS[stepRef.current]?.target ?? [];
        el = target.current = sel.map((q) => document.querySelector<HTMLElement>(q)).find(Boolean) ?? null;
      }
      let r: { x: number; y: number; width: number; height: number } | null = el ? el.getBoundingClientRect() : null;
      for (const q of (el && STEPS[stepRef.current]?.also) || []) { // spotlight several controls as one box
        const o = document.querySelector(q)?.getBoundingClientRect();
        if (!r || !o || !o.width) continue;
        const x = Math.min(r.x, o.x), y = Math.min(r.y, o.y);
        r = { x, y, width: Math.max(r.x + r.width, o.right) - x, height: Math.max(r.y + r.height, o.bottom) - y };
      }
      const key = r ? `${stepRef.current}:${r.x | 0},${r.y | 0},${r.width | 0},${r.height | 0}` : '';
      if (key !== last) { last = key; setRect(r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null); }
      const h = cardRef.current?.offsetHeight ?? 0;
      setCardH((o) => (o === h ? o : h));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // keys: capture phase so the map's own arrow/Esc shortcuts don't also fire
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (!typing && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(step + 1); }
      else if (!typing && e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); if (step > 0) go(step - 1); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, step, go, close]);

  useLayoutEffect(() => { if (open) headRef.current?.focus(); }, [open]);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const docked = mobile || vw <= 700;
  let cardStyle: CSSProperties = {};
  let cardClass = 'otour__card';
  if (docked) {
    // docked at the bottom; flips to the top only when the target sits in the lower half (the bottom sheet)
    const low = rect && rect.y + rect.h / 2 > vh * 0.5 && rect.y > vh * 0.3;
    cardClass += low ? ' otour__card--top' : ' otour__card--bottom';
  } else if (rect) {
    const W = 360, gap = 18;
    const left = rect.x + rect.w + gap + W < vw - 12 ? rect.x + rect.w + gap
      : rect.x - gap - W > 12 ? rect.x - gap - W : Math.min(Math.max(12, rect.x), vw - W - 12);
    const sideways = left >= rect.x + rect.w || left + W <= rect.x;
    const top = sideways ? Math.min(Math.max(12, rect.y), vh - cardH - 12)
      : rect.y + rect.h + gap + cardH < vh ? rect.y + rect.h + gap : Math.max(12, rect.y - gap - cardH);
    cardStyle = { left, top };
  } else cardClass += ' otour__card--centre';

  return (
    <>
      <span className="otour__anchor">
        <button ref={btnRef} type="button" className="otour__btn" onClick={() => (open ? close(false) : start())} aria-label="Take the guided tour" aria-expanded={open}>
          <span aria-hidden="true">?</span> Tour
        </button>
        {hint && !open && (
          <span className="otour__hint" role="note">
            <button type="button" className="link" onClick={start}>New here? Take the 2-minute tour</button>
            <button type="button" className="otour__hintx" aria-label="Dismiss tour hint" onClick={() => { setHint(false); writeSeen('dismissed'); }}>✕</button>
          </span>
        )}
      </span>
      {open && s && createPortal(
        <div className="otour" data-step={step + 1}>
          <div className={`otour__spot ${rect ? '' : 'otour__spot--full'}`} aria-hidden="true"
            style={rect ? { left: rect.x - PAD, top: rect.y - PAD, width: rect.w + PAD * 2, height: rect.h + PAD * 2 } : undefined} />
          <div ref={cardRef} className={cardClass} style={cardStyle} role="dialog" aria-modal="false" aria-labelledby="otour-h" aria-describedby="otour-b">
            <div className="otour__top">
              <span className="otour__count mono" aria-hidden="true">{step + 1} / {STEPS.length}</span>
              <button type="button" className="link small" onClick={() => close(false)}>Skip tour</button>
            </div>
            <h2 id="otour-h" ref={headRef} tabIndex={-1} className="otour__title">
              <span className="sr-only">Step {step + 1} of {STEPS.length}: </span>{s.title}
            </h2>
            <div id="otour-b" className="otour__body">{s.body}</div>
            {s.example && <p className="otour__example">{s.example}</p>}
            {busy && <p className="otour__busy small muted" role="status"><span className="spinner" aria-hidden="true" /> Setting this up…</p>}
            {s.final ? (
              <div className="otour__actions">
                <button type="button" className="btn btn--ghost" onClick={() => go(step - 1)}>Back</button>
                <a className="btn btn--ghost otour__watch" href={EXPLAINER} target="_blank" rel="noreferrer">▶ Watch the 2-minute explainer</a>
                <button type="button" className="btn" onClick={() => close(true)}>Explore on your own</button>
              </div>
            ) : (
              <div className="otour__actions">
                {step > 0 && <button type="button" className="btn btn--ghost" onClick={() => go(step - 1)}>Back</button>}
                <button type="button" className="btn" onClick={() => go(step + 1)}>Next</button>
              </div>
            )}
            {!docked && <p className="otour__keys small muted" aria-hidden="true"><kbd>←</kbd> <kbd>→</kbd> steps · <kbd>Esc</kbd> close</p>}
          </div>
          <p className="sr-only" aria-live="polite">Tour step {step + 1} of {STEPS.length}: {s.title}</p>
        </div>,
        document.body,
      )}
    </>
  );
}
