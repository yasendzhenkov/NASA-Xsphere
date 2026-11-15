import { canShow3D, starParams, targetSource } from '../src/ui/star3d/params.ts';
// Run: node --experimental-strip-types scripts/check-star3d.ts
// Barnard's Star as the scan report has it (Gaia DR3 G 8.194, BP−RP 2.834, parallax 546.976 mas)
const s = { id: 's001', class: 'known-star', ml_class: 'star', appearance_class: 'red-dwarf',
  crossmatch: [{ cat: 'Gaia DR3', id: '4472832130942575872', pmra_masyr: -801.6, pmdec_masyr: 10362.4, phot_g_mean_mag: 8.194, bp_rp: 2.834, parallax: 546.976 }, { cat: 'team targets.json', id: "Barnard's Star" }] };
const p = starParams(s, {}); console.log(p);
if (Math.abs(p.teff! - 3250) > 60) throw new Error('Teff off');          // literature ≈ 3200 K
if (Math.abs(p.radius! - 0.19) > 0.04) throw new Error('radius off');    // literature ≈ 0.19 R☉
if (Math.abs(p.distPc! - 1.83) > 0.01 || Math.abs(p.pm!.total - 10.39) > 0.02) throw new Error('distance / pm off');
if (!canShow3D('barnards-star', s) || canShow3D('somewhere', s) || targetSource([s])?.id !== 's001') throw new Error('button rule off');
// brown dwarf without Gaia: Teff from W1−W2, radius unknown, never throws on empty input
const w = starParams({ id: 'x', class: 'known-star', appearance_class: 'brown-dwarf', crossmatch: [{ cat: 'CatWISE2020', id: 'J0855', w1mpro: 19.456, w2mpro: 15.541 }] }, { plx_mas: null });
if (w.teff == null || w.radius != null || w.distPc != null) throw new Error('brown dwarf off');
starParams({ id: 'y', class: 'artefact' }, {}); if (canShow3D('wise-0855', { id: 'y', class: 'artefact' }) || canShow3D('r-draconis', null)) throw new Error('should hide');
console.log('ok');
