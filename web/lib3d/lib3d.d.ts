// Types for lib3d.js (used by the React app's lazy 3D view, web/src/ui/star3d).
export interface Lib3dParams {
  cls?: 'red-dwarf' | 'star' | 'brown-dwarf' | 'mira' | 'young-star' | 'asteroid' | 'comet';
  temp_K?: number; binary?: boolean; temp2_K?: number;
  pulse?: number;      // fractional radius pulsation (mira / variables)
  sun_ratio?: number;  // R☉ / R_star: draws the Sun beside the star at that relative size
}
export interface Lib3dController { setView(v: 'eye' | 'ir', lamUm?: number): void; setTemp(K: number): void; setSpots(on: boolean): void; setSpin(on: boolean): void; flare(): void; dispose(): void }
export function renderObject(el: HTMLElement, params?: Lib3dParams): Lib3dController;
