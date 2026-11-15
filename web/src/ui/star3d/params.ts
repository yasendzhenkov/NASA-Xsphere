/**
 * Physical parameters for the 3D impression, only from fields the scan report and bundle meta really carry:
 * Gaia DR3 cross-match (G, BP−RP, parallax, proper motion), CatWISE/AllWISE (W1, W2), the SPHEREx light curve.
 * The reports have no teff_gspphot / radius_gspphot, so Teff comes from a colour and the radius from L + Teff.
 * Colour → Teff and the bolometric correction: Mamajek's dwarf sequence (EEM_dwarf_UBVIJHK_colors_Teff.txt,
 * pas.rochester.edu/~emamajek, columns Bp-Rp, Teff, Mbol − M_G, W1-W2). Dwarf relations: approximate for giants.
 */
export interface Xm { cat: string; id: string; pmra_masyr?: number; pmdec_masyr?: number; phot_g_mean_mag?: number; bp_rp?: number; parallax?: number; w1mpro?: number; w2mpro?: number; teff_gspphot?: number; radius_gspphot?: number; lum_flame?: number }
export interface Src { id: string; class: string; ml_class?: string; appearance_class?: string; crossmatch?: Xm[]; flux?: Record<string, (number | null)[]> }
export interface Star3DParams {
  cls: 'red-dwarf' | 'star' | 'brown-dwarf' | 'mira' | 'young-star';
  teff: number | null; teffHow: string;   // null = not measured (model colour is then illustrative)
  radius: number | null; radiusHow: string;   // R☉
  distPc: number | null; distHow: string;
  pm: { ra: number; dec: number; total: number; how: string } | null;   // mas/yr, total in ″/yr
  vari: { ratio: number; band: string; n: number } | null;
}

export const FEATURED = ['barnards-star', 'eps-indi-b', 'wise-0855', 'rw-aurigae', 'r-draconis'];

// [BP−RP, Teff K, BC_G = Mbol − M_G] (Mamajek, dwarfs B9V … M9V; cut where the sequence stops being monotonic)
const BPRP: [number, number, number][] = [[-0.12,10700,-0.435],[-0.037,9700,-0.22],[0.068,8800,-0.065],[0.166,8250,0],[0.263,7760,0.05],[0.377,7220,0.07],[0.49,6820,0.08],[0.587,6550,0.09],[0.694,6180,0.11],[0.767,5990,0.095],[0.823,5770,0.085],[0.9,5480,0.062],[0.983,5270,0.037],[1.1,5100,-0.02],[1.21,4830,-0.07],[1.34,4600,-0.07],[1.43,4440,-0.18],[1.53,4300,-0.13],[1.7,4100,-0.34],[1.84,3850,-0.51],[1.97,3770,-0.53],[2.09,3660,-0.6],[2.23,3560,-0.7],[2.39,3470,-0.85],[2.5,3430,-0.84],[2.78,3270,-1.05],[2.94,3210,-1.11],[3.16,3110,-1.3],[3.35,3060,-1.41],[3.71,2930,-1.63],[4.16,2810,-2.07],[4.5,2740,-1.92],[4.72,2630,-2.36]];
// [W1−W2, Teff K] (Mamajek, L/T/Y dwarfs)
const W12: [number, number][] = [[0.265,2420],[0.28,2060],[0.3,1870],[0.36,1550],[0.48,1420],[0.68,1255],[0.99,1220],[1.43,1180],[1.7,1160],[1.86,1040],[2.0,950],[2.4,825],[2.6,750],[2.8,680],[3.0,600],[3.2,560],[3.4,510],[3.6,450],[3.9,400],[4.1,360],[4.4,325],[4.7,320],[6.1,250]];

/** Linear interpolation in column `col`; null outside the table (never extrapolate). */
function interp<T extends number[]>(t: T[], x: number, col: number): number | null {
  if (!Number.isFinite(x) || x < t[0][0] || x > t[t.length - 1][0]) return null;
  for (let i = 1; i < t.length; i++) if (x <= t[i][0]) { const f = (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]); return t[i - 1][col] + f * (t[i][col] - t[i - 1][col]); }
  return null;
}

const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function starParams(s: Src, meta: { plx_mas?: number | null; pmra_masyr?: number; pmdec_masyr?: number; astrometry_source?: string }): Star3DParams {
  const xm = s.crossmatch ?? [];
  const gaia = xm.find((c) => c.cat === 'Gaia DR3');
  const wise = xm.find((c) => (c.cat === 'CatWISE2020' || c.cat === 'AllWISE') && ok(c.w1mpro) && ok(c.w2mpro));
  const ac = s.appearance_class;
  const cls: Star3DParams['cls'] = ac === 'brown-dwarf' || ac === 'mira' || ac === 'young-star' || ac === 'red-dwarf' ? ac : 'star';
  const bd = cls === 'brown-dwarf';

  let teff: number | null = null, teffHow = bd ? 'not measured (no usable colour) · colour illustrative' : 'not measured';
  let bc: number | null = null;
  if (gaia && ok(gaia.teff_gspphot)) { teff = gaia.teff_gspphot; teffHow = 'Gaia DR3 GSP-Phot'; }
  else if (!bd && gaia && ok(gaia.bp_rp) && interp(BPRP, gaia.bp_rp, 1) != null) {
    teff = interp(BPRP, gaia.bp_rp, 1); bc = interp(BPRP, gaia.bp_rp, 2);
    teffHow = `estimated from Gaia BP−RP ${gaia.bp_rp.toFixed(2)} (dwarf colour sequence)`;
  } else if (bd && wise && interp(W12, wise.w1mpro! - wise.w2mpro!, 1) != null) {
    teff = interp(W12, wise.w1mpro! - wise.w2mpro!, 1);
    teffHow = `estimated from ${wise.cat} W1−W2 ${(wise.w1mpro! - wise.w2mpro!).toFixed(2)}` + (teff! < 500 ? ' · W1 is near its detection limit for objects this cold, so treat this as an upper estimate' : '');
  }

  const plx = gaia && ok(gaia.parallax) && gaia.parallax > 0 ? gaia.parallax : ok(meta.plx_mas) && meta.plx_mas > 0 ? meta.plx_mas : null;
  const distPc = plx ? 1000 / plx : null;
  const distHow = !plx ? 'unknown (no parallax)' : gaia && ok(gaia.parallax) ? 'Gaia DR3 parallax' : (meta.astrometry_source ?? 'catalogue parallax');

  let radius: number | null = null, radiusHow = 'unknown · drawn at nominal size';
  if (gaia && ok(gaia.radius_gspphot)) { radius = gaia.radius_gspphot; radiusHow = 'Gaia DR3 GSP-Phot'; }
  else if (teff && bc != null && plx && gaia && ok(gaia.phot_g_mean_mag)) {
    // L from G + parallax + BC_G, then R = √L · (T☉/T)²  (Mbol☉ 4.74, T☉ 5772 K)
    const mbol = gaia.phot_g_mean_mag + 5 * Math.log10(plx / 100) + bc;
    const L = 10 ** (-0.4 * (mbol - 4.74));
    radius = Math.sqrt(L) * (5772 / teff) ** 2;
    radiusHow = `from Gaia G, parallax and Teff (L ≈ ${L < 0.1 ? L.toFixed(4) : L < 100 ? L.toFixed(2) : Math.round(L).toLocaleString('en')} L☉)`;
  }

  const pmSrc = gaia && ok(gaia.pmra_masyr) && ok(gaia.pmdec_masyr) ? { ra: gaia.pmra_masyr, dec: gaia.pmdec_masyr, how: 'Gaia DR3' }
    : (() => { const c = xm.find((x) => ok(x.pmra_masyr) && ok(x.pmdec_masyr)); return c ? { ra: c.pmra_masyr!, dec: c.pmdec_masyr!, how: c.cat } : null; })();
  const pm = pmSrc ? { ...pmSrc, total: Math.hypot(pmSrc.ra, pmSrc.dec) / 1000 } : null;

  // variability: max/min brightness in the band with the most good visits (only for objects the rules call variable)
  let vari: Star3DParams['vari'] = null;
  if (s.class === 'variable' || cls === 'mira') {
    for (const [band, arr] of Object.entries(s.flux ?? {})) {
      const v = arr.filter((x): x is number => ok(x) && x > 0);
      if (v.length >= 3 && (!vari || v.length > vari.n)) vari = { ratio: Math.max(...v) / Math.min(...v), band, n: v.length };
    }
  }
  // dust round a young star dims and reddens it, and the dwarf colour table assumes none: say so instead of a firm number
  if (cls === 'young-star' && radius != null) radiusHow += ' · rough: dust around young stars dims them, so likely too small';
  return { cls, teff, teffHow, radius, radiusHow, distPc, distHow, pm, vari };
}

/** Button rule: a featured target the model or the rules call a star, with at least a temperature or a brown-dwarf look to draw. */
export function canShow3D(targetId: string, s: Src | null | undefined): boolean {
  if (!s || !FEATURED.includes(targetId)) return false;
  if (!(s.ml_class === 'star' || s.class === 'known-star' || s.class === 'variable')) return false;
  const p = starParams(s, {});
  return p.teff != null || p.cls === 'brown-dwarf';
}

/** The report source that is the featured target itself (cross-matched to team targets.json). */
export function targetSource<T extends Src>(sources: T[] | undefined): T | null {
  return sources?.find((s) => s.crossmatch?.some((c) => c.cat === 'team targets.json')) ?? null;
}
