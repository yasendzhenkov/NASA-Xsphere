/** "View in 3D": artist's impression drawn from the measured parameters (lazy chunk: three.js loads only here). */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { renderObject } from '../../../lib3d/lib3d.js';
import type { Star3DParams } from './params';

const NOMINAL_K: Record<Star3DParams['cls'], number> = { 'red-dwarf': 3200, star: 5772, 'brown-dwarf': 1000, mira: 2600, 'young-star': 4000 };
const fmt = (x: number, d = 2) => (x >= 100 ? Math.round(x).toLocaleString('en') : x >= 10 ? x.toFixed(1) : x.toFixed(d));

export default function Star3D({ name, p, onClose }: { name: string; p: Star3DParams; onClose: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    let ctl: ReturnType<typeof renderObject> | null = null;
    try {
      ctl = renderObject(el.current, {
        cls: p.cls, temp_K: p.teff ?? NOMINAL_K[p.cls],
        // shortcut: the pulse amplitude is a visual scale of the measured brightness range, not a radius measurement
        pulse: p.vari ? Math.min(.12, .025 * Math.log2(p.vari.ratio)) : undefined,
        sun_ratio: p.radius ? 1 / p.radius : undefined,
      });
    } catch { /* no WebGL: the parameter card still shows */ }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('keydown', esc); ctl?.dispose(); };
  }, [p, onClose]);

  const sunNote = p.radius == null ? null : p.radius < 1 / 8 || p.radius > 1 / 0.04 ? 'Right: the Sun, not to scale (sizes too different).' : 'Right: the Sun (5,772 K), to scale.';
  // proper-motion arrow: north up, east left (as on the sky)
  const ang = p.pm ? Math.atan2(p.pm.dec, -p.pm.ra) : 0;
  // portal: the floating card uses backdrop-filter, which would trap a fixed overlay inside it
  return createPortal(
    <div className="s3d" role="dialog" aria-modal="true" aria-label={`${name} in 3D`}>
      <div className="s3d__view" ref={el} />
      <div className="s3d__card">
        <header className="s3d__head">
          <h3>{name}</h3>
          <button className="iconbtn" onClick={onClose} aria-label="Close 3D view (Esc)" title="Close (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
          </button>
        </header>
        <p className="s3d__label">Artist's impression from measured parameters — not an image</p>
        <dl className="s3d__params mono">
          <dt>Teff</dt><dd>{p.teff ? `${(Math.round(p.teff / 10) * 10).toLocaleString('en')} K` : 'Not measured'}<small>{p.teff ? p.teffHow : 'no usable colour in the catalogues for this object'}</small></dd>
          <dt>Radius</dt><dd>{p.radius ? `${fmt(p.radius)} R☉` : '—'}<small>{p.radiusHow}</small></dd>
          <dt>Distance</dt><dd>{p.distPc ? `${fmt(p.distPc)} pc` : '—'}<small>{p.distHow}</small></dd>
          <dt>Motion</dt><dd>{p.pm ? `${p.pm.total >= 1 ? p.pm.total.toFixed(1) : p.pm.total.toFixed(3)}″/yr` : '—'}<small>{p.pm ? `${p.pm.how} proper motion` : 'not measured'}</small></dd>
          {p.vari && <><dt>Varies</dt><dd>×{fmt(p.vari.ratio, 1)}<small>brightness range in {p.vari.band}, {p.vari.n} SPHEREx visits (pulse sped up)</small></dd></>}
        </dl>
        {p.pm && (
          <svg className="s3d__pm" viewBox="-34 -34 68 68" width="76" height="76" aria-label="Direction of motion on the sky">
            <text x="0" y="-24" textAnchor="middle">N</text><text x="-27" y="4" textAnchor="middle">E</text>
            <line x1="0" y1="0" x2={18 * Math.cos(ang)} y2={-18 * Math.sin(ang)} />
            <circle cx="0" cy="0" r="2" />
            <path d="M0,-5 L5,0 L0,5 z" transform={`translate(${18 * Math.cos(ang)},${-18 * Math.sin(ang)}) rotate(${-ang * 180 / Math.PI})`} />
          </svg>
        )}
        <p className="s3d__note">{[sunNote, p.cls === 'brown-dwarf' ? (p.teff ? 'Drawn dim red: at this temperature it glows almost only in the infrared.' : 'No temperature measured, so the colour is illustrative: drawn dim red, as brown dwarfs glow almost only in the infrared.') : p.teff ? 'Colour from Teff (blackbody).' : 'Colour illustrative.', p.cls === 'brown-dwarf' ? 'Cloud bands are typical of cool dwarfs, not observed.' : 'Surface pattern is not observed.', 'Drag to turn.'].filter(Boolean).join(' ')}</p>
      </div>
    </div>,
    document.body,
  );
}
