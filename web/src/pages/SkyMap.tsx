/**
 * Map-first front end: a friendly, zoomable sky map. Zooming into (or selecting) one of the processed
 * targets loads its SPHEREx frames and plays the blink right there on the map.
 *
 *   fov > 30°      simplified map (Milky Way, bright stars, constellation lines, target markers)
 *   30° … 4°       cross-fade into real survey imagery (Aladin Lite v3 / HiPS, loaded lazily below 45°)
 *   ≤ 1.5°         a target in view opens its patch → "Loading this patch…" → blink + floating card
 *   > 3° (user)    patch closes, blink stops, back to the map
 *   ≤ 1° & empty   "Not processed yet"
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BandId, FlagsJson, GaiaJson, Manifest, SpectrumJson, TargetMeta, ViewMode } from '../ui/lib/contracts';
import { BlinkCanvas } from '../ui/viewer';
import { useCatalog } from '../ui/lib/useCatalog';
import { loadFlags, loadFrames, loadGaia, loadManifest, loadSpectrum, matchTarget, nearestTarget } from '../ui/lib/data';
import { DEFAULT_OVERLAYS, MAX_FPS, parseUrl, viewUrl, type Overlay, type ViewState } from '../ui/lib/url';
import { maskCss, sequenceLambda, type PaletteId } from '../ui/lib/palette';
import { compass, formatDec, formatMjdLong, formatRa, mjdToDate } from '../ui/lib/astro';
import { MockBanner } from '../ui/components/Chrome';
import { AdvancedDrawer, BandChips, ModeToggle, StateCard } from '../ui/components/Controls';
import { ExplainPanel, motionSentence } from '../ui/components/ExplainPanel';
import { TourCard } from '../ui/components/Tour';
import { SpectrumPanel } from '../ui/components/SpectrumPanel';
import { CandidatePanel, SharePanel } from '../ui/components/SharePanel';
import { BANDS, COLOUR_STOPS, HINTS, KIND_LABEL, MODES, STATES, TARGET_COPY, TOUR_END } from '../ui/copy';
import { IntroCard } from '../ui/map/IntroCard';
import { AboutSheet } from '../ui/map/AboutSheet';
import { MiniChart } from '../ui/map/MiniChart';
import { VisitTimeline } from '../ui/map/VisitTimeline';
import { DetectionOverlay, DetectionPanel, buildDetections, type Report } from '../ui/map/Detections';
import { canShow3D, starParams, targetSource } from '../ui/star3d/params';
import { MarkerLegend, MarkerOverlay, trackMoves } from '../ui/map/Markers';
import { MapSearch, type SearchHit } from '../ui/map/MapSearch';
import { drawSky } from '../ui/map/renderSky';
import { HIPS_CREDIT, loadAladin, pickHips } from '../ui/map/aladin';
import {
  D2R, angDist, clampFov, fitCamera, fovRamp, makeProjector, setViewport, slerp, type Camera,
} from '../ui/map/sphere';

// three.js lives in this chunk only: the map does not pay for it until someone opens the 3D view
const Star3D = lazy(() => import('../ui/star3d/Star3D'));

const OPEN_FOV = 1.5;
const CLOSE_FOV = 3;
const EMPTY_FOV = 1.0;
const ALADIN_LOAD_FOV = 45;
const MIN_LOADING_MS = 650;
const TOUR_ORDER = ['barnards-star', 'wise-0855', 'eps-indi-b', 'rw-aurigae', 'r-draconis'];
const INTRO_KEY = 'sxb-intro-seen';
/** Zoom levels where the UI changes (open/close patch, imagery load, "whole sky" button); see the constants above. */
const FOV_STEPS = [1.0, 1.5, 3, 45, 60, 360];

/** localStorage can throw (private mode, blocked storage) — never let that break the page. */
function introSeen() {
  try { return window.localStorage.getItem(INTRO_KEY) === '1'; } catch { return false; }
}
function markIntroSeen() {
  try { window.localStorage.setItem(INTRO_KEY, '1'); } catch { /* ignore */ }
}

/** Aladin's own usage ping fails on some networks; keep that from showing up as an uncaught error. */
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    const st = String((e.reason as Error | undefined)?.stack ?? '');
    if (st.includes('aladin')) e.preventDefault();
  });
}

type Load = 'idle' | 'loading' | 'ok' | 'error' | 'empty';
type Panel = 'none' | 'spectrum' | 'share' | 'candidate';
interface Anim { from: Camera; to: Camera; t0: number; dur: number; Lc: number }

function prefersReducedMotion() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export function SkyMap({ loc }: { loc: string }) {
  const catalog = useCatalog();
  const reduced = useMemo(prefersReducedMotion, []);

  // ---------- refs for the 60 fps layer (no React re-render per frame) ----------
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trailCanvasRef = useRef<HTMLCanvasElement>(null);
  const trailRef = useRef<{ label: string; ra: number; dec: number }[] | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const prevFrame = useRef(0);
  const aladinDivRef = useRef<HTMLDivElement>(null);
  const patchRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const markerEls = useRef<Record<string, HTMLButtonElement | null>>({});
  const camRef = useRef<Camera>({ ra: 200, dec: 10, fov: 220 });
  const sizeRef = useRef({ W: 800, H: 600, dpr: 1 });
  const animRef = useRef<Anim | null>(null);
  const wheelRef = useRef<{ L: number; x: number; y: number } | null>(null);
  const inertiaRef = useRef<{ vx: number; vy: number } | null>(null);
  const dirtyRef = useRef(true);
  const viewTimer = useRef<number | null>(null);
  const lastBand = useRef(-1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aladinRef = useRef<any>(null);
  const aladinSync = useRef<Camera | null>(null);
  const fovCorr = useRef(1);
  const aladinReadyAt = useRef(0);
  const patchInfo = useRef<{ id: string; ra: number; dec: number; deg: number } | null>(null);
  const userMoved = useRef(false);
  const gesture = useRef(false);
  const dragged = useRef(0);
  const lastWritten = useRef<string | null>(null);
  const initialised = useRef(false);

  // ---------- React state ----------
  const [view, setView] = useState<Camera>(camRef.current);
  const [aladinState, setAladinState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [hint, setHint] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [panel, setPanel] = useState<Panel>('none');
  const [tour, setTour] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [intro, setIntro] = useState(false);
  const [about, setAbout] = useState(false);
  const [demo, setDemo] = useState(false);
  const [tourEnd, setTourEnd] = useState(false);
  const [shared, setShared] = useState(false);
  const [loops, setLoops] = useState(0);
  const [showMe, setShowMe] = useState(false);
  const [chartFlash, setChartFlash] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const grabY = useRef<number | null>(null);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 700px)');
    if (!mq) return;
    const f = () => setMobile(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);

  const [band, setBand] = useState<BandId | undefined>(undefined);
  const [mode, setMode] = useState<ViewMode>('blink');
  const [speed, setSpeed] = useState(1);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(!reduced);
  const [stretchA, setStretchA] = useState<number | undefined>(undefined);
  const [vmax, setVmax] = useState<number | undefined>(undefined);
  const [invert, setInvert] = useState(false);
  const [palette, setPalette] = useState<PaletteId>('infrared');
  const [smooth, setSmooth] = useState(false);
  const [overlays, setOverlays] = useState<Overlay[]>(DEFAULT_OVERLAYS);
  const [excluded, setExcluded] = useState<number[]>([]);
  const [advOpen, setAdvOpen] = useState(false);
  const [picked, setPicked] = useState<{ ra: number; dec: number } | null>(null);

  // ---------- "Select an area": drag a box → the engine fetches that patch live → it opens like a target ----------
  const [areaMode, setAreaMode] = useState(false);
  const [areaRect, setAreaRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [areaJob, setAreaJob] = useState<{ title: string; detail: string; progress: number; error?: boolean } | null>(null);
  const areaRun = useRef(0);
  // detections layer (change engine + discovery report)
  const [detOn, setDetOn] = useState(false);
  const [detFocus, setDetFocus] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [s3d, setS3d] = useState(false);
  const closeS3d = useCallback(() => setS3d(false), []);
  /** The chosen area stays drawn on the sky (glued to it while the map moves) until its photos open. */
  const pendingArea = useRef<{ ra: number; dec: number; w: number; h: number } | null>(null);
  const pendingEl = useRef<HTMLDivElement>(null);
  const [emptyDismissed, setEmptyDismissed] = useState(false);
  useEffect(() => { setEmptyDismissed(false); }, [selectedId]);

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [frames, setFrames] = useState<Float32Array[] | null>(null);
  const [load, setLoad] = useState<Load>('idle');
  const [spectrum, setSpectrum] = useState<SpectrumJson | null>(null);
  const [flags, setFlags] = useState<FlagsJson | null>(null);
  const [gaia, setGaia] = useState<GaiaJson | null>(null);

  // frames are cached per target/band so tour stops and band switches back are instant
  const bundleCache = useRef(new Map<string, Promise<{ m: Manifest; f: Float32Array[] }>>());
  const getBundle = useCallback((id: string, b: BandId) => {
    const key = `${id}/${b}`;
    let p = bundleCache.current.get(key);
    if (!p) {
      p = loadManifest(id, b).then(async (m) => ({ m, f: await loadFrames(id, b, m) }));
      p.catch(() => bundleCache.current.delete(key));
      bundleCache.current.set(key, p);
    }
    return p;
  }, []);

  const metas = useMemo(() => (catalog ? catalog.index.map((e) => catalog.metas[e.id]).filter(Boolean) : []), [catalog]);
  const meta: TargetMeta | null = selectedId && catalog ? catalog.metas[selectedId] ?? null : null;
  const entry = meta && catalog ? catalog.index.find((e) => e.id === meta.id) : undefined;
  const patchOpen = Boolean(meta && opened);
  /** C5 `no-coverage`: Processing marks a target with 0 epochs in index.json → no frames to fetch. */
  const noCoverage = Boolean(meta && (entry?.n_epochs === 0 || meta.epochs?.length === 0));
  const activeBand: BandId | undefined = meta
    ? band && entry?.bands.includes(band) ? band : entry?.bands.includes(meta.default_band) ? meta.default_band : entry?.bands[0]
    : undefined;

  const markDirty = useCallback(() => { dirtyRef.current = true; }, []);

  /** Read the stage size now (the ResizeObserver may not have fired yet on the first frame). */
  const measure = useCallback(() => {
    const el = stageRef.current;
    if (!el) return sizeRef.current;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (r.width !== sizeRef.current.W || r.height !== sizeRef.current.H)) {
      sizeRef.current = { ...sizeRef.current, W: r.width, H: r.height };
      setViewport(r.width, r.height);
    }
    return sizeRef.current;
  }, []);

  // ---------- camera helpers ----------
  const projector = useCallback(() => makeProjector(camRef.current, sizeRef.current.W, sizeRef.current.H), []);

  const panBy = useCallback((dx: number, dy: number) => {
    const { W, H } = sizeRef.current;
    const c = projector().unproject(W / 2 - dx, H / 2 - dy);
    camRef.current = { ...camRef.current, ra: c.ra, dec: Math.max(-89.999, Math.min(89.999, c.dec)) };
    dirtyRef.current = true;
  }, [projector]);

  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    const { W, H } = sizeRef.current;
    const P = projector();
    const p = P.unproject(px, py);
    const next = { ...camRef.current, fov: clampFov(camRef.current.fov * factor) };
    const P2 = makeProjector(next, W, H);
    const q = P2.project(p.ra, p.dec);
    const c = P2.unproject(W / 2 + (q.x - px), H / 2 + (q.y - py));
    camRef.current = { ra: c.ra, dec: Math.max(-89.999, Math.min(89.999, c.dec)), fov: next.fov };
    dirtyRef.current = true;
  }, [projector]);

  const stopMotion = () => { animRef.current = null; inertiaRef.current = null; };

  const flyTo = useCallback((to: Camera, opts: { instant?: boolean } = {}) => {
    wheelRef.current = null;
    inertiaRef.current = null;
    userMoved.current = false;
    const from = { ...camRef.current };
    const target = { ...to, fov: clampFov(to.fov) };
    if (reduced || opts.instant) {
      animRef.current = null;
      camRef.current = target;
      dirtyRef.current = true;
      return;
    }
    const dist = angDist(from.ra, from.dec, target.ra, target.dec);
    const L0 = Math.log(from.fov), L1 = Math.log(target.fov);
    const peak = Math.log(Math.max(from.fov, target.fov, Math.min(110, dist * 1.05)));
    // quadratic Bézier in log(fov): bump out to `peak` mid-flight, but never overshoot when we start/end wide
    const Lc = peak > Math.max(L0, L1) + 0.01 ? 2 * peak - (L0 + L1) / 2 : Math.max(L0, L1);
    const zoomSpan = Math.abs(L0 - L1) / Math.log(2);
    const dur = Math.max(650, Math.min(1700, 450 + dist * 5 + zoomSpan * 75));
    animRef.current = { from, to: target, t0: performance.now(), dur, Lc };
    dirtyRef.current = true;
  }, [reduced]);

  // ---------- selection ----------
  /** Camera that frames a target's patch in the free part of the screen (beside the card / More sheet). */
  const sheetRef = useRef(false);
  const patchCamera = useCallback((m: TargetMeta): Camera => {
    const { W, H } = measure();
    const mobile = W < 700;
    // top of the free area = bottom of the banner + search bar, plus room for the patch's name label
    const top = (topRef.current?.getBoundingClientRect().bottom ?? 76) + 28;
    const cardTop = cardRef.current?.getBoundingClientRect().top;
    const mobileBottom = sheetRef.current ? H * 0.42 - 22 : cardTop && cardTop > top + 160 ? cardTop - 30 : H - 260;
    let a = mobile
      ? { x0: 0, x1: W, y0: top, y1: mobileBottom }
      : { x0: 370, x1: W - (sheetRef.current ? Math.min(420, 0.38 * W) + 32 : 0), y0: top, y1: H - 40 };
    if (a.x1 - a.x0 < 160 || a.y1 - a.y0 < 140) a = { x0: 0, x1: W, y0: top, y1: H - 40 };
    const px = 0.86 * Math.min(a.x1 - a.x0, a.y1 - a.y0);
    // widen the view when older survey positions exist, so the "then vs now" ring stays on screen
    const farthest = Math.max(0, ...(m.archival_positions ?? []).map((p) => angDist(p.ra_deg, p.dec_deg, m.ra_deg, m.dec_deg)));
    const spanDeg = Math.max(m.fov_arcsec / 3600, 2 * farthest * 1.3);
    const fov = clampFov((spanDeg * W) / Math.max(80, px));
    const ox = (a.x0 + a.x1) / 2 - W / 2, oy = (a.y0 + a.y1) / 2 - H / 2;
    const c = makeProjector({ ra: m.ra_deg, dec: m.dec_deg, fov }, W, H).unproject(W / 2 - ox, H / 2 - oy);
    return { ra: c.ra, dec: c.dec, fov };
  }, [measure]);

  const select = useCallback((id: string, opts: { fly?: boolean; open?: boolean; keep?: Partial<ViewState>; shared?: boolean } = {}) => {
    const m = catalog?.metas[id];
    if (!m) return;
    setSelectedId(id);
    setShared(Boolean(opts.shared));
    setLoops(0);
    setShowMe(false);
    setTourEnd(false);
    setIntro(false);
    setChartOpen(false);
    setOpened(Boolean(opts.open));
    setEmpty(false);
    setNotice(null);
    setPanel('none');
    setExcluded([]);
    setPicked(null);
    setVmax(undefined);
    const k = opts.keep ?? {};
    setFrame(k.frame ?? 0);
    setBand(k.band);
    setStretchA(k.stretchA);
    if (k.mode) setMode(k.mode);
    if (k.speed) setSpeed(Math.min(MAX_FPS, k.speed));
    if (k.overlays) setOverlays(k.overlays);
    setPlaying(!reduced && !(k.frame && k.frame > 0));
    patchInfo.current = { id, ra: m.ra_deg, dec: m.dec_deg, deg: m.fov_arcsec / 3600 };
    if (opts.fly !== false) flyTo(patchCamera(m));
    dirtyRef.current = true;
  }, [catalog, flyTo, patchCamera, reduced]);

  const closePatch = useCallback((fly: boolean) => {
    setSelectedId(null);
    setOpened(false);
    setSheet(false);
    setPanel('none');
    patchInfo.current = null;
    if (fly) flyTo({ ...camRef.current, fov: 24 });
    dirtyRef.current = true;
  }, [flyTo]);

  /** Whole-sky view of all targets. `room` keeps space free for the intro card (left) or the tour-end card (bottom). */
  const overview = useCallback((instant = false, room: 'none' | 'left' | 'bottom' = 'none') => {
    if (!metas.length) return;
    const { W, H } = measure();
    const inset = W < 700
      ? { left: 16, right: 96, top: 140, bottom: room === 'none' ? 90 : 330 }
      : { left: room === 'left' ? 420 : 90, right: 230, top: 130, bottom: room === 'bottom' ? 230 : 110 };
    flyTo(fitCamera(metas.map((m) => ({ ra: m.ra_deg, dec: m.dec_deg })), W, H, inset), { instant });
  }, [metas, flyTo, measure]);

  const dismissIntro = useCallback(() => { setIntro(false); markIntroSeen(); }, []);

  /** Tour stop: fresh view of the object; WISE 0855 starts at short wavelengths, where it is invisible. */
  const selectTour = useCallback((id: string) => {
    setTourStep(0);
    select(id, { keep: { mode: 'blink', band: id === 'wise-0855' ? 'D1' : undefined } });
  }, [select]);

  const startTour = useCallback(() => {
    dismissIntro();
    setTour(true);
    setTourEnd(false);
    selectTour(TOUR_ORDER.find((id) => catalog?.metas[id]) ?? TOUR_ORDER[0]);
  }, [dismissIntro, selectTour, catalog]);

  const finishTour = useCallback(() => {
    setTour(false);
    setSelectedId(null);
    setOpened(false);
    setSheet(false);
    patchInfo.current = null;
    overview(false, 'bottom');
    setTourEnd(true);
  }, [overview]);

  /** One-tap share: the native share sheet on phones, otherwise copy the link. */
  const shareLink = useCallback(async (url: string, title: string, key: string) => {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    if (coarse && navigator.share) {
      try { await navigator.share({ title, url }); return; } catch { /* cancelled → fall back to copy */ }
    }
    let ok = true;
    try { await navigator.clipboard.writeText(url); } catch { ok = false; }
    const tag = ok ? key : `${key}-fail`;
    setCopied(tag);
    window.setTimeout(() => setCopied((c) => (c === tag ? null : c)), ok ? 1800 : 4000);
  }, []);

  // ---------- apply a URL (first load, back/forward, brand link) ----------
  const applyUrl = useCallback((search: string, initial: boolean) => {
    if (!catalog) return;
    const st = parseUrl({ pathname: '/', search });
    const keep: Partial<ViewState> = { mode: st.mode, speed: st.speed, frame: st.frame, band: st.band, stretchA: st.stretchA, overlays: st.overlays };
    if (initial) setDemo(new URLSearchParams(search).get('demo') === '1');
    if (st.palette) setPalette(st.palette); // viewing preferences: kept across targets, only a link can set them
    if (st.smooth) setSmooth(true);
    setTour(Boolean(st.tour));
    setTourStep(0);
    // tour link without a target: start at the first stop, flying in from the whole sky
    if (st.tour && !st.target && st.ra === undefined) {
      overview(true);
      selectTour(TOUR_ORDER.find((id) => catalog.metas[id]) ?? TOUR_ORDER[0]);
      return;
    }
    let target: TargetMeta | null = null;
    if (st.target) {
      const hit = catalog.metas[st.target] ? catalog.index.find((e) => e.id === st.target) : matchTarget(st.target, catalog.index, catalog.metas);
      if (hit) target = catalog.metas[hit.id];
      else setNotice({ title: STATES['name-not-found'].title, body: `“${st.target}” — ${STATES['name-not-found'].body}` });
    } else if (st.ra !== undefined && st.dec !== undefined) {
      target = nearestTarget(st.ra, st.dec, metas);
      if (!target) {
        if (selectedId) closePatch(false);
        flyTo({ ra: st.ra, dec: st.dec, fov: st.view?.fov ?? 0.5 }, { instant: initial });
        return;
      }
    }
    if (target) {
      const isShared = initial && !st.tour;
      if (st.view && st.view.fov <= CLOSE_FOV) {
        flyTo(st.view, { instant: true });
        select(target.id, { fly: false, open: true, keep, shared: isShared });
      } else {
        // arriving from a link: start on a wide view around the object (constellations visible), then fly in
        if (initial) flyTo({ ra: target.ra_deg, dec: target.dec_deg + 6, fov: 70 }, { instant: true });
        select(target.id, { keep, shared: isShared });
      }
      return;
    }
    if (selectedId) closePatch(false);
    const showIntro = initial && !st.view && !introSeen();
    if (showIntro) setIntro(true);
    if (st.view) flyTo(st.view, { instant: initial });
    else overview(initial, showIntro ? 'left' : 'none');
  }, [catalog, metas, select, selectTour, closePatch, flyTo, overview, selectedId]);

  useEffect(() => {
    if (!catalog || initialised.current) return;
    initialised.current = true;
    applyUrl(window.location.search, true);
    lastWritten.current = window.location.pathname + window.location.search;
  }, [catalog, applyUrl]);

  useEffect(() => {
    if (!initialised.current || loc === lastWritten.current) return;
    lastWritten.current = loc;
    applyUrl(loc.slice(loc.indexOf('?') >= 0 ? loc.indexOf('?') : loc.length), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc]);

  // ---------- render loop ----------
  useEffect(() => {
    let raf = 0;
    const render = () => {
      const c = canvasRef.current;
      if (!c) return;
      const { W, H, dpr } = sizeRef.current;
      const cam = camRef.current;
      const P = makeProjector(cam, W, H);
      const aladinReady = Boolean(aladinRef.current);
      // fade the survey in over ~1.2 s after it is created, so tiles have time to arrive
      const warm = aladinReady ? Math.min(1, (performance.now() - aladinReadyAt.current) / 1200) : 0;
      if (aladinReady && warm < 1) dirtyRef.current = true;
      const aA = warm * fovRamp(cam.fov, 6, 40); // 1 when zoomed in
      const floor = 0.55 * (1 - warm);
      // cross-fade as a pair: the simple map only disappears as far as the imagery has appeared
      const base = Math.max(fovRamp(cam.fov, 30, 3.5), floor, 1 - aA);
      const lines = Math.max(fovRamp(cam.fov, 45, 8), Math.min(0.5, floor));
      drawSky(c.getContext('2d')!, P, cam.fov, { base, lines }, dpr);

      if (aladinDivRef.current) aladinDivRef.current.style.opacity = String(aA);
      const a = aladinRef.current;
      // keep the survey camera in step below 70° even while it is invisible, so its tiles are already loading
      if (a && (aA > 0.002 || cam.fov < 70)) {
        const last = aladinSync.current;
        if (!last || last.ra !== cam.ra || last.dec !== cam.dec || last.fov !== cam.fov) {
          try {
            a.gotoRaDec(cam.ra, cam.dec);
            a.setFoV(cam.fov * fovCorr.current);
            const f = a.getFov?.();
            const fx = Array.isArray(f) ? f[0] : f;
            if (fx > 0 && cam.fov < 60) {
              const r = (cam.fov * fovCorr.current) / fx;
              if (Math.abs(r - 1) > 0.01) fovCorr.current = Math.max(0.3, Math.min(3, fovCorr.current * Math.sqrt(r)));
            }
          } catch { /* Aladin not ready for this call yet */ }
          aladinSync.current = { ...cam };
        }
      }

      // markers
      const pi = patchInfo.current;
      const shown: { el: HTMLButtonElement; x: number; y: number }[] = [];
      for (const id in markerEls.current) {
        const el = markerEls.current[id];
        const m = catalog?.metas[id];
        if (!el || !m) continue;
        const q = P.project(m.ra_deg, m.dec_deg);
        const hidden = q.cosc < -0.8 || q.x < -80 || q.x > W + 80 || q.y < -40 || q.y > H + 40 || (pi?.id === id && cam.fov <= CLOSE_FOV);
        el.style.visibility = hidden ? 'hidden' : 'visible';
        if (!hidden) {
          el.style.transform = `translate3d(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px, 0)`;
          shown.push({ el, x: q.x, y: q.y });
        }
      }
      // place each label right / left / below / above, whichever covers no other marker or label and stays on screen
      const placed: [number, number, number, number][] = [];
      const overlaps = (b: [number, number, number, number]) => placed.some((o) => b[0] < o[2] + 4 && b[2] > o[0] - 4 && b[1] < o[3] + 2 && b[3] > o[1] - 2);
      for (const a of shown) {
        const lab = a.el.lastElementChild as HTMLElement | null;
        const lw = lab?.offsetWidth ?? 120, lh = lab?.offsetHeight ?? 30;
        const boxes: Record<string, [number, number, number, number]> = {
          right: [a.x + 14, a.y - lh / 2, a.x + 14 + lw, a.y + lh / 2],
          left: [a.x - 14 - lw, a.y - lh / 2, a.x - 14, a.y + lh / 2],
          below: [a.x - lw / 2, a.y + 14, a.x + lw / 2, a.y + 14 + lh],
          above: [a.x - lw / 2, a.y - 14 - lh, a.x + lw / 2, a.y - 14],
        };
        const ok = (b: [number, number, number, number]) =>
          b[0] > 2 && b[2] < W - 2 && b[1] > 2 && b[3] < H - 2 && !overlaps(b) &&
          !shown.some((o) => o !== a && o.x > b[0] - 10 && o.x < b[2] + 10 && o.y > b[1] - 10 && o.y < b[3] + 10);
        const side = (['right', 'left', 'below', 'above'] as const).find((k) => ok(boxes[k])) ?? 'right';
        placed.push(boxes[side]);
        if (a.el.dataset.side !== side) a.el.dataset.side = side;
      }

      // patch
      const pe = patchRef.current;
      if (pe && pi) {
        const q = P.project(pi.ra, pi.dec);
        const size = Math.max(24, pi.deg * D2R * q.k);
        pe.style.width = `${size}px`;
        pe.style.height = `${size}px`;
        pe.style.transform = `translate3d(${(q.x - size / 2).toFixed(1)}px, ${(q.y - size / 2).toFixed(1)}px, 0)`;
        pe.style.visibility = q.cosc > 0 ? 'visible' : 'hidden';
        pe.style.setProperty('--arcmin', `${(size / (pi.deg * 60)).toFixed(1)}px`);
        const small = size < 200 ? '1' : '';
        if (pe.dataset.small !== small) pe.dataset.small = small;
      }

      // the area being fetched: same box the user drew, kept on the sky
      const ae = pendingEl.current, pa = pendingArea.current;
      if (ae && pa) {
        const q = P.project(pa.ra, pa.dec);
        const w = Math.max(16, (pa.w / 60) * D2R * q.k), h = Math.max(16, (pa.h / 60) * D2R * q.k);
        ae.style.width = `${w}px`;
        ae.style.height = `${h}px`;
        ae.style.transform = `translate3d(${(q.x - w / 2).toFixed(1)}px, ${(q.y - h / 2).toFixed(1)}px, 0)`;
        ae.style.visibility = q.cosc > 0 ? 'visible' : 'hidden';
      }

      // "then vs now": where older surveys saw this star (drawn outside the patch so the blink stays clean)
      const tc = trailCanvasRef.current;
      if (tc) {
        const tctx = tc.getContext('2d')!;
        tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        tctx.clearRect(0, 0, W, H);
        const trail = trailRef.current;
        if (trail && pi && patchRef.current && cam.fov <= CLOSE_FOV && trail.length > 1) {
          const c0 = P.project(pi.ra, pi.dec);
          const half = Math.max(12, (pi.deg * D2R * c0.k) / 2) + 2;
          tctx.save();
          tctx.beginPath();
          tctx.rect(0, 0, W, H);
          // keep the patch and its name/date labels clear
          tctx.rect(c0.x - half, c0.y - half - 26, 2 * half, 2 * half + 52);
          tctx.clip('evenodd');
          const pts = trail.map((t) => ({ ...t, ...P.project(t.ra, t.dec) }));
          tctx.strokeStyle = 'rgba(240,228,66,.85)';
          tctx.lineWidth = 1.5;
          tctx.setLineDash([4, 4]);
          tctx.beginPath();
          pts.forEach((q, i) => (i ? tctx.lineTo(q.x, q.y) : tctx.moveTo(q.x, q.y)));
          tctx.stroke();
          tctx.setLineDash([]);
          tctx.restore();
          // rings + labels: whole or not at all (never half-hidden behind the patch)
          const ex = [c0.x - half, c0.y - half - 26, c0.x + half, c0.y + half + 26];
          const hits = (b: number[]) => b[0] < ex[2] && b[2] > ex[0] && b[1] < ex[3] && b[3] > ex[1];
          tctx.font = '600 11px Inter, system-ui, sans-serif';
          tctx.textBaseline = 'middle';
          pts.slice(0, -1).forEach((q) => {
            if (hits([q.x - 8, q.y - 8, q.x + 8, q.y + 8])) return;
            tctx.strokeStyle = 'rgba(240,228,66,.95)';
            tctx.lineWidth = 2;
            tctx.beginPath();
            tctx.arc(q.x, q.y, 7, 0, Math.PI * 2);
            tctx.stroke();
            const tw = tctx.measureText(q.label).width;
            const right = [q.x + 12, q.y - 9, q.x + 20 + tw, q.y + 9];
            const left = [q.x - 20 - tw, q.y - 9, q.x - 12, q.y + 9];
            const box = !hits(right) && right[2] < W ? right : !hits(left) && left[0] > 0 ? left : null;
            if (!box) return;
            tctx.fillStyle = 'rgba(8,10,16,.75)';
            tctx.fillRect(box[0], box[1], box[2] - box[0], 18);
            tctx.fillStyle = '#f0e442';
            tctx.fillText(q.label, box[0] + 4, q.y);
          });
        }
      }

      // React only needs the camera when something visible depends on it. During a scripted flight that is
      // just the zoom thresholds; otherwise a light throttle. Keeps flights free of re-render hitches.
      const band = FOV_STEPS.findIndex((f) => cam.fov <= f);
      const crossed = band !== lastBand.current;
      lastBand.current = band;
      if (viewTimer.current === null && (!animRef.current || crossed)) {
        viewTimer.current = window.setTimeout(() => {
          viewTimer.current = null;
          setView({ ...camRef.current });
        }, animRef.current ? 0 : 120);
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const an = animRef.current;
      if (an) {
        const t = Math.min(1, (now - an.t0) / an.dur);
        const u = ease(t);
        const pos = slerp(an.from, an.to, Math.min(1, u * 1.15));
        const L0 = Math.log(an.from.fov), L1 = Math.log(an.to.fov);
        const L = (1 - u) * (1 - u) * L0 + 2 * u * (1 - u) * an.Lc + u * u * L1;
        camRef.current = { ra: pos.ra, dec: pos.dec, fov: clampFov(Math.exp(L)) };
        if (t >= 1) { camRef.current = { ...an.to }; animRef.current = null; lastBand.current = -2; }
        dirtyRef.current = true;
      }
      const w = wheelRef.current;
      if (w) {
        const d = w.L - Math.log(camRef.current.fov);
        if (Math.abs(d) < 0.003) wheelRef.current = null;
        else zoomAt(Math.exp(d * (reduced ? 1 : 0.3)), w.x, w.y);
      }
      const inr = inertiaRef.current;
      if (inr) {
        panBy(inr.vx * 16, inr.vy * 16);
        inr.vx *= 0.9; inr.vy *= 0.9;
        if (Math.hypot(inr.vx, inr.vy) < 0.02) inertiaRef.current = null;
      }
      if (dirtyRef.current) { dirtyRef.current = false; render(); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [catalog, panBy, zoomAt, reduced]);

  // the map is a fixed full-screen layer: if focus ever scrolls it (older browsers without overflow: clip), undo that
  useEffect(() => {
    const root = stageRef.current?.parentElement;
    const stage = stageRef.current;
    const reset = (e: Event) => { const el = e.currentTarget as HTMLElement; if (el.scrollLeft || el.scrollTop) { el.scrollLeft = 0; el.scrollTop = 0; } };
    root?.addEventListener('scroll', reset);
    stage?.addEventListener('scroll', reset);
    return () => { root?.removeEventListener('scroll', reset); stage?.removeEventListener('scroll', reset); };
  }, []);

  // ---------- size ----------
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { W: r.width, H: r.height, dpr };
      setViewport(r.width, r.height);
      camRef.current = { ...camRef.current, fov: clampFov(camRef.current.fov) };   // a resize can shrink the allowed zoom-out
      const c = canvasRef.current;
      if (c) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
      const tc = trailCanvasRef.current;
      if (tc) { tc.width = Math.round(r.width * dpr); tc.height = Math.round(r.height * dpr); }
      dirtyRef.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------- gestures: drag, pinch, wheel ----------
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    let pinch: { d: number; mx: number; my: number } | null = null;
    let lastMove = { t: 0, vx: 0, vy: 0 };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const interacted = () => {
      setHint(false);
      setIntro((v) => { if (v) markIntroSeen(); return false; });
      userMoved.current = true;
      animRef.current = null;
      loadAladin().catch(() => { /* imagery is optional */ });
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const p = local(e);
      pts.set(e.pointerId, p);
      stopMotion();
      wheelRef.current = null;
      gesture.current = true;
      if (pts.size === 1) { start = p; dragging = false; }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        dragging = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
    };
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1 && start) {
        if (!dragging && Math.hypot(p.x - start.x, p.y - start.y) > 5) {
          dragging = true;
          interacted();
          try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        }
        if (dragging) {
          const dx = p.x - prev.x, dy = p.y - prev.y;
          panBy(dx, dy);
          const now = performance.now();
          const dt = Math.max(1, now - lastMove.t);
          lastMove = { t: now, vx: 0.7 * (dx / dt) + 0.3 * lastMove.vx, vy: 0.7 * (dy / dt) + 0.3 * lastMove.vy };
        }
      } else if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        interacted();
        if (d > 0) zoomAt(pinch.d / d, mx, my);
        panBy(mx - pinch.mx, my - pinch.my);
        pinch = { d, mx, my };
      }
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size === 1) {
        // pinch → pan with the remaining finger
        start = [...pts.values()][0];
        pinch = null;
        return;
      }
      if (pts.size === 0) {
        gesture.current = false;
        if (dragging) {
          dragged.current = performance.now();
          if (!reduced && performance.now() - lastMove.t < 80 && Math.hypot(lastMove.vx, lastMove.vy) > 0.15) {
            inertiaRef.current = { vx: lastMove.vx, vy: lastMove.vy };
          }
        }
        dragging = false;
        pinch = null;
        start = null;
        markDirty();
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      interacted();
      inertiaRef.current = null;
      const p = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const k = e.ctrlKey ? 0.012 : 0.0022;
      const cur = wheelRef.current ? wheelRef.current.L : Math.log(camRef.current.fov);
      const L = Math.log(clampFov(Math.exp(cur + Math.max(-1.2, Math.min(1.2, dy * k)))));
      wheelRef.current = { L, x: p.x, y: p.y };
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    // A trackpad pinch arrives as ctrl+wheel. Over the cards, search bar or popups it used to zoom the whole PAGE
    // (browser zoom): everything got huge, the controls left the screen and it looked stuck. Pinch now always zooms
    // the sky map instead, wherever the pointer is; plain scrolling over a card still scrolls the card.
    const pagePinch = (e: WheelEvent) => {
      if (!e.ctrlKey || el.contains(e.target as Node)) return;
      e.preventDefault();
      wheel(e);
    };
    const noGesture = (e: Event) => e.preventDefault();   // Safari's own pinch events
    window.addEventListener('wheel', pagePinch, { passive: false, capture: true });
    document.addEventListener('gesturestart', noGesture);
    document.addEventListener('gesturechange', noGesture);
    return () => {
      window.removeEventListener('wheel', pagePinch, { capture: true });
      document.removeEventListener('gesturestart', noGesture);
      document.removeEventListener('gesturechange', noGesture);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    };
  }, [panBy, zoomAt, markDirty, reduced]);

  const zoomKey = useCallback((factor: number) => {
    const { W, H } = sizeRef.current;
    setHint(false);
    userMoved.current = true;
    animRef.current = null;
    const cur = wheelRef.current ? wheelRef.current.L : Math.log(camRef.current.fov);
    wheelRef.current = { L: Math.log(clampFov(Math.exp(cur) * factor)), x: W / 2, y: H / 2 };
  }, []);

  // ---------- lazy Aladin ----------
  useEffect(() => {
    if (aladinState !== 'idle' || (view.fov > ALADIN_LOAD_FOV && !selectedId)) return;
    setAladinState('loading');
    Promise.all([loadAladin(), pickHips()])
      .then(([A, hips]) => {
        const div = aladinDivRef.current;
        if (!div) return;
        if (!hips) throw new Error('no HiPS mirror reachable');
        const cam = camRef.current;
        aladinRef.current = A.aladin(div, {
          survey: hips, backgroundColor: 'rgb(5,7,12)', fov: cam.fov, target: `${cam.ra} ${cam.dec}`, projection: 'STG', cooFrame: 'ICRS',
          showReticle: false, showZoomControl: false, showFullscreenControl: false, showLayersControl: false,
          showGotoControl: false, showFrame: false, showCooGrid: false, showProjectionControl: false,
          showSimbadPointerControl: false, showCooGridControl: false, showSettingsControl: false, showShareControl: false,
          showContextMenu: false, showStatusBar: false, showCooLocation: false, showFov: false,
        });
        aladinSync.current = null;
        aladinReadyAt.current = performance.now();
        // dev-only handle for checking alignment between our projection and Aladin's
        if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__skymap = { aladin: aladinRef.current, cam: camRef, size: sizeRef };
        setAladinState('ready');
        dirtyRef.current = true;
      })
      .catch(() => setAladinState('error'));
  }, [view.fov, aladinState, selectedId]);

  // ---------- open / close / auto-select / not-processed ----------
  useEffect(() => {
    if (!catalog || animRef.current) return;
    const settling = gesture.current || Boolean(wheelRef.current);
    if (selectedId) {
      // zooming back out closes the patch right away (even mid-gesture), so the blink stops
      if (userMoved.current && view.fov > CLOSE_FOV) closePatch(false);
      else if (!opened && view.fov <= OPEN_FOV && !settling) setOpened(true);
      return;
    }
    if (settling || areaMode || areaJob) return;
    if (view.fov <= OPEN_FOV) {
      const { W, H } = sizeRef.current;
      const P = makeProjector(view, W, H);
      let best: TargetMeta | null = null;
      let bd = Infinity;
      for (const m of metas) {
        const q = P.project(m.ra_deg, m.dec_deg);
        if (q.cosc <= 0 || q.x < W * 0.04 || q.x > W * 0.96 || q.y < H * 0.04 || q.y > H * 0.96) continue;
        const d = Math.hypot(q.x - W / 2, q.y - H / 2);
        if (d < bd) { bd = d; best = m; }
      }
      if (best) { select(best.id); return; }
    }
    setEmpty(view.fov <= EMPTY_FOV);
  }, [view, catalog, metas, selectedId, opened, select, closePatch, areaMode, areaJob]);

  // ---------- load the patch (only now does anything heavy download) ----------
  useEffect(() => {
    if (!patchOpen || !meta || !activeBand || noCoverage) {
      setLoad('idle');
      setManifest(null);
      setFrames(null);
      return;
    }
    let alive = true;
    const cached = bundleCache.current.has(`${meta.id}/${activeBand}`);
    setLoad('loading');
    const t0 = performance.now();
    (async () => {
      try {
        const { m, f } = await getBundle(meta.id, activeBand);
        // a short, readable "Loading this patch…" the first time; instant when it was preloaded
        const wait = (cached ? 0 : MIN_LOADING_MS) - (performance.now() - t0);
        if (wait > 0 && !reduced) await sleep(wait);
        if (!alive) return;
        if (m.frames.length === 0) { setLoad('empty'); return; }
        setManifest(m);
        setFrames(f);
        setFrame((i) => Math.min(i, m.frames.length - 1));
        setExcluded([]);
        setVmax(undefined);
        setLoad('ok');
        dirtyRef.current = true;
      } catch {
        if (alive) setLoad('error');
      }
    })();
    return () => { alive = false; };
  }, [patchOpen, meta, activeBand, reduced, getBundle, noCoverage]);

  // tour: while you look at this stop, quietly fetch the next one
  useEffect(() => {
    if (!tour || !meta || load !== 'ok' || !catalog) return;
    const order = TOUR_ORDER.filter((id) => catalog.metas[id]);
    const next = order[order.indexOf(meta.id) + 1];
    if (!next) return;
    const e = catalog.index.find((x) => x.id === next);
    const nm = catalog.metas[next];
    const b: BandId | undefined = next === 'wise-0855' && e?.bands.includes('D1') ? 'D1' : e?.bands.includes(nm.default_band) ? nm.default_band : e?.bands[0];
    if (b) getBundle(next, b).catch(() => { /* will retry on arrival */ });
  }, [tour, meta, load, catalog, getBundle]);

  useEffect(() => {
    if (!patchOpen || !meta) return;
    let alive = true;
    loadSpectrum(meta.id).then((s) => alive && setSpectrum(s));
    setReport(null); setDetFocus(null); setS3d(false);
    fetch(`/reports/${meta.id}.json`).then((r) => (r.ok ? r.json() : null)).then((r) => alive && setReport(r)).catch(() => { /* no report for this patch */ });
    loadGaia(meta.id).then((g) => alive && setGaia(g));
    loadFlags().then((f) => alive && setFlags(f));
    return () => { alive = false; };
  }, [patchOpen, meta]);

  useEffect(() => { dirtyRef.current = true; }, [patchOpen, load, selectedId, areaJob]);

  // trail of archival positions (oldest → SPHEREx position) for the "then vs now" overlay
  useEffect(() => {
    const ap = meta?.archival_positions ?? [];
    trailRef.current = meta && ap.length
      ? [...ap].sort((a, b) => a.epoch - b.epoch).map((p) => ({ label: `${p.survey} ${Math.round(p.epoch)}`, ra: p.ra_deg, dec: p.dec_deg }))
          .concat([{ label: 'SPHEREx', ra: meta.ra_deg, dec: meta.dec_deg }])
      : null;
    dirtyRef.current = true;
  }, [meta]);

  // count completed loops (drives the gentle hints and the "shared with you" note)
  useEffect(() => {
    if (frame < prevFrame.current && playing) setLoops((l) => l + 1);
    prevFrame.current = frame;
  }, [frame, playing]);

  // on phones the card grows once the patch has loaded → re-frame so the patch sits above it
  useEffect(() => {
    if (load !== 'ok' || !meta || sizeRef.current.W >= 700 || sheet) return;
    const id = window.setTimeout(() => flyTo(patchCamera(meta)), 60);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, meta?.id, tour && patchOpen]);

  useEffect(() => {
    sheetRef.current = sheet;
    if (meta && patchOpen) flyTo(patchCamera(meta));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  // ---------- URL sync (C5 + view) ----------
  const shareState: ViewState = useMemo(() => ({
    embed: false,
    view: { ra: view.ra, dec: view.dec, fov: view.fov },
    ...(meta && patchOpen
      ? { target: meta.id, mode, speed, frame: playing ? 0 : frame, band, stretchA, overlays, tour, palette, smooth }
      : { mode: 'blink' as ViewMode, speed: 1, frame: 0, overlays: DEFAULT_OVERLAYS }),
  }), [view, meta, patchOpen, mode, speed, frame, playing, band, stretchA, overlays, tour, palette, smooth]);

  useEffect(() => {
    if (!initialised.current) return;
    const id = window.setTimeout(() => {
      if (animRef.current || demo) return; // demo/recording links stay exactly as typed
      const c = camRef.current;
      const url = viewUrl({ ...shareState, view: { ra: c.ra, dec: c.dec, fov: c.fov } });
      if (url !== window.location.pathname + window.location.search) {
        window.history.replaceState(null, '', url);
      }
      lastWritten.current = url;
    }, 350);
    return () => window.clearTimeout(id);
  }, [shareState, demo]);

  // ---------- playback ----------
  const n = manifest?.frames.length ?? 0;
  const activeFrames = useMemo(() => Array.from({ length: n }, (_, i) => i).filter((i) => !excluded.includes(i)), [n, excluded]);
  const step = useCallback((d: number) => {
    setPlaying(false);
    setFrame((i) => {
      const pos = activeFrames.indexOf(i);
      return activeFrames[(pos + d + activeFrames.length) % activeFrames.length] ?? 0;
    });
  }, [activeFrames]);
  const toggleOverlay = (o: Overlay, on: boolean) => setOverlays((s) => (on ? [...new Set([...s, o])] : s.filter((x) => x !== o)));
  const ready = patchOpen && load === 'ok' && manifest && frames;

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { W, H } = sizeRef.current;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomKey(1 / 1.8); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomKey(1.8); return; }
      if (e.key === 'Escape') {
        if (areaMode) { setAreaMode(false); setAreaRect(null); return; }
        if (about) setAbout(false);
        else if (intro) dismissIntro();
        else if (sheet) setSheet(false);
        else if (selectedId) closePatch(true);
        return;
      }
      if (ready) {
        if (e.key === ' ') { if (el.tagName === 'BUTTON') return; e.preventDefault(); setPlaying((p) => !p); if (mode === 'side') setMode('blink'); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'd' || e.key === 'D') setMode((m) => (m === 'diff' ? 'blink' : 'diff'));
        else if (e.key === 'b' || e.key === 'B') setMode('blink');
        else if (e.key === 's' || e.key === 'S') { setMode('side'); setSheet(true); }
        return;
      }
      const pan = 0.12 * Math.min(W, H);
      const dirs: Record<string, [number, number]> = { ArrowLeft: [pan, 0], ArrowRight: [-pan, 0], ArrowUp: [0, pan], ArrowDown: [0, -pan] };
      if (dirs[e.key]) { e.preventDefault(); stopMotion(); userMoved.current = true; setHint(false); panBy(...dirs[e.key]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ready, step, mode, sheet, selectedId, closePatch, zoomKey, panBy, about, intro, dismissIntro, areaMode]);

  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => setHint(false), 12000);
    return () => window.clearTimeout(id);
  }, [hint]);

  // ---------- search ----------
  const onSearch = useCallback((h: SearchHit) => {
    setHint(false);
    setNotice(null);
    dismissIntro();
    setTourEnd(false);
    if (h.kind === 'target') { select(h.id); return; }
    const near = nearestTarget(h.ra, h.dec, metas);
    if (near) { select(near.id); return; }
    if (selectedId) closePatch(false);
    flyTo({ ra: h.ra, dec: h.dec, fov: 0.6 });
  }, [select, metas, selectedId, closePatch, flyTo, dismissIntro]);

  // ---------- area selection ----------
  const AREA_MAX_ARCMIN = 30;
  /** Box (screen px, stage coords) → centre + size on the sky, capped at 30′ like the engine. */
  const areaFromRect = useCallback((r: { x0: number; y0: number; x1: number; y1: number }) => {
    const P = projector();
    const xm = (r.x0 + r.x1) / 2, ym = (r.y0 + r.y1) / 2;
    const c = P.unproject(xm, ym);
    const l = P.unproject(Math.min(r.x0, r.x1), ym), rr = P.unproject(Math.max(r.x0, r.x1), ym);
    const t = P.unproject(xm, Math.min(r.y0, r.y1)), b = P.unproject(xm, Math.max(r.y0, r.y1));
    let w = angDist(l.ra, l.dec, rr.ra, rr.dec) * 60, h = angDist(t.ra, t.dec, b.ra, b.dec) * 60;
    const big = Math.max(w, h);
    if (big > AREA_MAX_ARCMIN) { w *= AREA_MAX_ARCMIN / big; h *= AREA_MAX_ARCMIN / big; }
    return { ra: c.ra, dec: c.dec, w, h, capped: big > AREA_MAX_ARCMIN };
  }, [projector]);

  const startAreaMode = useCallback(() => {
    setHint(false); setNotice(null); dismissIntro(); setTourEnd(false); setTour(false);
    if (selectedId) closePatch(false);
    areaRun.current++; pendingArea.current = null; setAreaJob(null); setAreaRect(null); setAreaMode(true);   // a new box replaces any area still loading
    // a box drawn on the whole-sky view would be far too big: get close enough first
    if (camRef.current.fov > 2) flyTo({ ...camRef.current, fov: 1.2 });
  }, [selectedId, closePatch, flyTo, dismissIntro]);

  const runArea = useCallback(async (a: { ra: number; dec: number; w: number; h: number }) => {
    if (!catalog) return;
    const run = ++areaRun.current;
    const label = `Selected area ${a.w.toFixed(1)}′ × ${a.h.toFixed(1)}′ · RA ${a.ra.toFixed(3)}° Dec ${a.dec >= 0 ? '+' : ''}${a.dec.toFixed(3)}°`;
    const STATUS: Record<string, string> = {
      queued: 'Waiting for a free slot…', listing: 'Asking NASA which photos cover this area…',
      fetching: 'Reading the photos from NASA and lining them up…', 'checking catalogues': 'Almost there…',
    };
    pendingArea.current = a; dirtyRef.current = true;
    setAreaJob({ title: STATUS.listing, detail: label, progress: 0.02 });
    try {
      const r = await fetch('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ box: { ra_deg: a.ra, dec_deg: a.dec, w_arcmin: a.w, h_arcmin: a.h }, band: 'D4', classify: false }) });
      const start = await r.json().catch(() => ({}));
      if (!r.ok || !start.job) throw new Error(start?.detail?.message || 'The live engine is not connected here.');
      const key: string = start.job;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (run !== areaRun.current) return;
        const j = await (await fetch(`/scan/${key}`)).json();
        // engine messages are "code: plain sentence (raw upstream error)": show only the sentence
        if (j.status === 'error') throw new Error(String(j.message || 'The area could not be processed.').replace(/^[a-z-]+:\s*/, '').replace(/\s*\(.*$/s, ''));
        if (j.bundle || j.status === 'done') break;   // photos are ready; object checks may still be running
        setAreaJob({ title: STATUS[j.status] ?? 'Working…', progress: Math.max(0.02, j.progress ?? 0),
          detail: [label, j.n_photos_total ? `${j.n_photos_total} photos found` : '',
            // SPHEREx passes over a spot a few times a year: every pass's photos are stacked into ONE blink frame
            j.visits?.length ? `stacked into ${j.visits.length} visits = ${j.visits.length} blink frames` : ''].filter(Boolean).join(' · ') });
        await sleep(1500);
      }
      const id = `live-${key}`;
      const { m } = await getBundle(id, 'D4');
      if (run !== areaRun.current) return;
      const nx = m.nx ?? 64;
      const pix = Math.abs(m.wcs?.cdelt?.[0] ?? 3.075 / 3600) * 3600;
      const meta = {
        id, name: label, aliases: [], kind: 'custom', ra_deg: a.ra, dec_deg: a.dec, ref_epoch: 2016.0,
        pmra_masyr: 0, pmdec_masyr: 0, default_band: 'D4', fov_arcsec: nx * pix,
        epochs: m.frames.map((f, i) => ({ id: i, label: f.label ?? `Visit ${i + 1}`, mjd_start: f.mjd, mjd_end: f.mjd, n: f.n_exposures })),
      } as unknown as TargetMeta;
      catalog.metas[id] = meta;
      if (!catalog.index.some((e) => e.id === id)) catalog.index.push({ id, name: label, kind: 'custom', bands: ['D4'], n_epochs: m.frames.length });
      pendingArea.current = null;
      setAreaJob(null);
      select(id, { open: true });
    } catch (err) {
      if (run !== areaRun.current) return;
      pendingArea.current = null;
      setAreaJob({ title: 'Could not load this area', detail: (err as Error).message, progress: 0, error: true });
    }
  }, [catalog, getBundle, select]);

  const areaHandlers = {
    // the scroll wheel still zooms the map while choosing, so any spot can be reached
    onWheel: (e: React.WheelEvent<HTMLDivElement>) => { stageRef.current?.dispatchEvent(new WheelEvent('wheel', e.nativeEvent)); },
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      const b = stageRef.current!.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      e.currentTarget.setPointerCapture(e.pointerId);
      setAreaRect({ x0: x, y0: y, x1: x, y1: y });
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!areaRect) return;
      const b = stageRef.current!.getBoundingClientRect();
      setAreaRect({ ...areaRect, x1: e.clientX - b.left, y1: e.clientY - b.top });
    },
    onPointerUp: () => {
      const r = areaRect; setAreaRect(null);
      if (!r || Math.abs(r.x1 - r.x0) < 10 || Math.abs(r.y1 - r.y0) < 10) return;
      setAreaMode(false);
      runArea(areaFromRect(r));
    },
  };
  const areaLive = areaRect ? areaFromRect(areaRect) : null;

  // ---------- derived copy ----------
  const s3dParams = useMemo(() => {
    const ts = targetSource(report?.sources);
    return meta && ts && canShow3D(meta.id, ts) ? starParams(ts, meta) : null;
  }, [report, meta]);
  const det = useMemo(() => (detOn && manifest ? buildDetections(manifest, report, frame) : null), [detOn, manifest, report, frame]);
  const nEpochs = manifest?.frames.length ?? 0;
  const fr = manifest?.frames[frame];
  const saturated = Boolean(meta?.expected?.saturated && (manifest?.warnings?.some((w) => w.includes('saturat')) || fr?.flags_at_target?.includes('OVERFLOW')));
  const stretch = manifest ? { a: stretchA ?? manifest.stretch.a, vmin: manifest.stretch.vmin, vmax: vmax ?? manifest.stretch.vmax } : { a: 0.1, vmin: 0, vmax: 1 };
  const bandCopy = BANDS.find((b) => b.id === activeBand);
  const motion = manifest && !meta?.id.startsWith('live-') ? motionSentence(manifest) : null;   // an area has no single object to track
  const copy = meta ? TARGET_COPY[meta.id] : undefined;
  const nearest = useMemo(() => {
    if (!empty || !metas.length) return null;
    return [...metas].sort((a, b) => angDist(view.ra, view.dec, a.ra_deg, a.dec_deg) - angDist(view.ra, view.dec, b.ra_deg, b.dec_deg))[0];
  }, [empty, metas, view.ra, view.dec]);
  const overlayProps = { crosshair: overlays.includes('crosshair'), track: overlays.includes('track'), gaia: overlays.includes('gaia') ? gaia : null, wise: overlays.includes('wise') ? gaia : null, flags: overlays.includes('flags') };
  const zoomedIn = view.fov < 60;
  const chartKind: 'lightcurve' | 'spectrum' | null = meta
    ? meta.kind === 'variable' ? 'lightcurve' : meta.default_band === 'D56' ? 'spectrum' : null
    : null;
  const isMover = meta?.kind === 'mover' || meta?.kind === 'companion-mover';

  // "then vs now": oldest archival position → SPHEREx position, in plain words
  const thenNow = useMemo(() => {
    const ap = meta?.archival_positions;
    if (!meta || !ap?.length || !fr) return null;
    const old = [...ap].sort((a, b) => a.epoch - b.epoch)[0];
    const arcmin = angDist(old.ra_deg, old.dec_deg, meta.ra_deg, meta.dec_deg) * 60;
    if (arcmin < 0.2) return null;
    const dEast = (((meta.ra_deg - old.ra_deg + 540) % 360) - 180) * Math.cos((meta.dec_deg * Math.PI) / 180);
    const dNorth = meta.dec_deg - old.dec_deg;
    const years = Math.round(mjdToDate(fr.mjd).getFullYear() - old.epoch);
    return `Since ${old.survey} saw it in ${Math.round(old.epoch)}, it has travelled ${arcmin.toFixed(1)}′ ${compass(dEast, dNorth)} in ${years} years. The yellow ring on the map marks where it was.`;
  }, [meta, fr]);

  // the card shows ONE insight line (everything else lives in More → At a glance). Priority:
  // shared-link note → "try Difference" once a mover has looped a while → then-vs-now → variable hint → motion
  const insight: { kind: 'hint' | 'then' | 'motion'; text: string } | null =
    shared && loops < 2 ? { kind: 'hint', text: HINTS.shared }
    : !tour && isMover && mode === 'blink' && loops >= 4 ? { kind: 'hint', text: HINTS.mover }
    : thenNow ? { kind: 'then', text: thenNow }
    : !tour && meta?.kind === 'variable' ? { kind: 'hint', text: HINTS.variable }
    : motion ? { kind: 'motion', text: motion }
    : null;
  const doShowMe = () => {
    setOverlays((o) => [...new Set([...o, 'crosshair', 'track'] as Overlay[])]);
    setShowMe(true);
    window.setTimeout(() => setShowMe(false), 3500);
  };
  const viewLink = () => {
    const c = camRef.current;
    return viewUrl({ ...shareState, view: { ra: c.ra, dec: c.dec, fov: c.fov } }, { absolute: true });
  };
  const tp = fr?.target_px;
  const nx = manifest?.nx ?? 64, ny = manifest?.ny ?? 64;

  const togglePlay = () => { if (mode === 'side') { setMode('blink'); setPlaying(true); } else setPlaying((p) => !p); };
  const moreContent = meta && manifest && frames ? (
    <>
      {!mobile && (
        <div className="sheet__head">
          <button className="playbtn playbtn--sm" onClick={togglePlay} disabled={nEpochs < 2}
            aria-label={playing && mode !== 'side' ? 'Pause (Space)' : 'Play (Space)'}>
            {playing && mode !== 'side'
              ? <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
              : <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.2v11.6a.6.6 0 0 0 .9.5l9.2-5.8a.6.6 0 0 0 0-1L4.9 1.7a.6.6 0 0 0-.9.5Z" fill="currentColor" /></svg>}
          </button>
          <h2>{meta.name}</h2>
          <button className="iconbtn" onClick={() => setSheet(false)} aria-label="Close More">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
          </button>
        </div>
      )}

      <section className="sheet__sec sheet__glance">
        <h3>At a glance</h3>
        {mobile && copy && <p><strong>Look for:</strong> {copy.lookFor} <button className="link" onClick={() => { setSheet(false); doShowMe(); }}>{HINTS.showMe}</button></p>}
        {motion && <p className="glance__motion">{motion}</p>}
        {thenNow && <p className="glance__then">{thenNow}</p>}
        {nEpochs === 1 && <p className="glance__note">{STATES['one-epoch'].body}</p>}
        {nEpochs === 2 && <p className="glance__note">{STATES['two-epochs'].body}</p>}
        {saturated && <p className="glance__note">{STATES['saturated-target'].body}</p>}
        {mobile && chartKind && <MiniChart spectrum={spectrum} kind={chartKind} visit={fr?.epoch ?? frame} onOpen={() => setPanel('spectrum')} />}
      </section>

      <section className="sheet__sec">
        <h3>Playback</h3>
        <div className="sheet__row"><ModeToggle value={mode} onChange={setMode} disabledDiff={nEpochs < 2} /></div>
        <p className="small muted">{MODES[mode].help}</p>
        {mode === 'side' && (
          <div className="sheet__side">
            <BlinkCanvas manifest={manifest} frames={frames} mode="side" frameIndex={frame} playing={false} fps={speed}
              stretch={stretch} zoom={6} invert={invert} palette={palette} smooth={smooth} excludeEpochs={excluded} overlays={overlayProps} />
          </div>
        )}
        <label className="slider">
          <span>Speed</span>
          <input type="range" min={0.25} max={MAX_FPS} step={0.25} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-valuetext={`${speed} frames per second`} />
          <span className="mono">{speed.toFixed(2)}/s</span>
        </label>
      </section>

      <section className="sheet__sec">
        <h3>Infrared colour</h3>
        <BandChips available={entry?.bands ?? []} value={activeBand!} onChange={setBand} />
        {bandCopy && <p className="small muted">Showing <strong>{bandCopy.range}</strong> — {bandCopy.plain.charAt(0).toLowerCase() + bandCopy.plain.slice(1)}. Every visit in the loop is the same colour.</p>}
      </section>

      <div className="actions">
        <button className={`btn ${panel === 'spectrum' ? '' : 'btn--ghost'}`} onClick={() => setPanel(panel === 'spectrum' ? 'none' : 'spectrum')}>Spectrum</button>
        <button className={`btn ${panel === 'share' ? '' : 'btn--ghost'}`} onClick={() => setPanel(panel === 'share' ? 'none' : 'share')}>Share / embed</button>
        <button className={`btn ${panel === 'candidate' ? '' : 'btn--ghost'}`} onClick={() => setPanel(panel === 'candidate' ? 'none' : 'candidate')}>Flag a candidate</button>
      </div>
      {panel === 'spectrum' && <SpectrumPanel spectrum={spectrum} defaultView={meta.kind === 'variable' && nEpochs > 3 ? 'lightcurve' : 'spectrum'} onClose={() => setPanel('none')} />}
      {panel === 'share' && <SharePanel state={shareState} meta={meta} onClose={() => setPanel('none')} />}
      {panel === 'candidate' && <CandidatePanel state={shareState} meta={meta} manifest={manifest} picked={picked} onClose={() => setPanel('none')} />}

      <AdvancedDrawer
        open={advOpen} onToggle={() => setAdvOpen((o) => !o)}
        stretchA={stretchA ?? manifest.stretch.a} onStretchA={setStretchA}
        vmax={vmax ?? manifest.stretch.vmax} vmaxDefault={manifest.stretch.vmax} onVmax={setVmax}
        invert={invert} onInvert={setInvert}
        palette={palette} onPalette={setPalette}
        smooth={smooth} onSmooth={setSmooth}
        flags={overlays.includes('flags')} onFlags={(v) => toggleOverlay('flags', v)}
        crosshair={overlays.includes('crosshair')} onCrosshair={(v) => toggleOverlay('crosshair', v)}
        track={overlays.includes('track')} onTrack={(v) => toggleOverlay('track', v)}
        gaia={overlays.includes('gaia')} onGaia={(v) => toggleOverlay('gaia', v)}
        wise={overlays.includes('wise')} onWise={(v) => toggleOverlay('wise', v)}
        frames={manifest.frames} excluded={excluded}
        onExclude={(i) => setExcluded((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))}
      />

      <ExplainPanel meta={meta} manifest={manifest} frameIndex={frame} flags={flags} mock={Boolean(catalog?.mock)} flagColour={maskCss(palette, sequenceLambda(manifest))} />
      {!tour && <button className="link small" onClick={() => { setTour(true); setTourStep(0); }}>Take the guided tour</button>}
      {!mobile && <p className="kbd-help small muted">Keys: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> visit · <kbd>B</kbd> blink · <kbd>D</kbd> difference · <kbd>S</kbd> side by side · <kbd>+</kbd>/<kbd>−</kbd> zoom · <kbd>Esc</kbd> back to the map</p>}
    </>
  ) : null;

  return (
    <div className={`skymap ${sheet ? 'skymap--sheet' : ''} ${tour ? 'skymap--tour' : ''} ${mobile ? 'skymap--mobile' : ''}`}>
      <div
        ref={stageRef}
        className="skymap__stage"
        role="application"
        aria-roledescription="sky map"
        aria-label="Zoomable map of the sky. Drag to look around, scroll or pinch to zoom, plus and minus keys zoom, arrow keys pan."
      >
        <div ref={aladinDivRef} className="skymap__aladin" aria-hidden="true" />
        <canvas ref={canvasRef} className="skymap__canvas" aria-hidden="true" />

        {patchOpen && meta && (
          <div ref={patchRef} className={`patch patch--${load}`}>
            {ready ? (
              <BlinkCanvas
                manifest={manifest!}
                frames={frames!}
                mode={mode === 'side' ? 'blink' : mode}
                frameIndex={frame}
                playing={playing && mode !== 'side' && nEpochs > 1}
                fps={speed}
                stretch={stretch}
                zoom={8}
                invert={invert}
                palette={palette}
                smooth={smooth}
                excludeEpochs={excluded}
                overlays={{ ...overlayProps, crosshair: false, track: false, gaia: null, wise: null }}
                onFrameChange={setFrame}
                onPixelClick={(ra, dec) => { if (performance.now() - dragged.current > 250) setPicked({ ra, dec }); }}
              />
            ) : (
              <div className="patch__loading" aria-hidden="true" />
            )}
            {ready && showMe && tp && (
              <span className="patch__ring" aria-hidden="true" style={{ left: `${((tp[0] + 0.5) / nx) * 100}%`, top: `${((tp[1] + 0.5) / ny) * 100}%` }} />
            )}
            {ready && <MarkerOverlay manifest={manifest!} frame={frame} show={overlayProps} />}
            {ready && det && <DetectionOverlay list={det.list} nx={manifest!.nx ?? 64} ny={manifest!.ny ?? manifest!.nx ?? 64} focus={detFocus} targetPx={overlayProps.track ? tp : null} />}
            <span className="patch__frame" aria-hidden="true" />
            <span className="patch__name">{meta.name}</span>
            {ready && fr && (
              <span className="patch__label" aria-hidden="true">
                <span className="mono">
                  {mode === 'diff' ? `Visit ${frame === 0 ? 2 : frame + 1} − ${frame === 0 ? 1 : frame}` : `Visit ${frame + 1}/${nEpochs}`} · {formatMjdLong(fr.mjd)}
                </span>
                <span className="patch__scale"><i />1′</span>
              </span>
            )}
          </div>
        )}

        {areaJob && !areaJob.error && (
          <div ref={pendingEl} className="selbox selbox--onsky" aria-hidden="true">
            <i className="selbox__c selbox__c--tl" /><i className="selbox__c selbox__c--tr" /><i className="selbox__c selbox__c--bl" /><i className="selbox__c selbox__c--br" />
            <span className="selbox__tag mono">{Math.round(areaJob.progress * 100)}% · fetching SPHEREx photos</span>
          </div>
        )}
        <canvas ref={trailCanvasRef} className="skymap__trail" aria-hidden="true" />

        <div className="markers">
          {metas.map((m) => (
            <button
              key={m.id}
              ref={(el) => { markerEls.current[m.id] = el; }}
              className={`marker ${selectedId === m.id ? 'marker--on' : ''}`}
              style={{ visibility: 'hidden' }}
              onClick={() => { if (performance.now() - dragged.current > 250) { setHint(false); dismissIntro(); select(m.id); } }}
              onPointerEnter={() => { loadAladin().catch(() => { /* optional */ }); }}
              onFocus={() => { loadAladin().catch(() => { /* optional */ }); }}
              aria-label={`${m.name} — ${KIND_LABEL[m.kind]}. Zoom in and play its SPHEREx blink.`}
            >
              <span className="marker__dot" aria-hidden="true" />
              <span className="marker__label">
                <span className="marker__name">{m.name}</span>
                <span className="marker__kind">{KIND_LABEL[m.kind]}</span>
                {TARGET_COPY[m.id] && <span className="marker__line">{TARGET_COPY[m.id].oneLiner}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>

      {areaMode && (
        <div className="area-layer" {...areaHandlers} aria-label="Drag a box on the sky to choose an area">
          {areaRect && (
            <div className={`selbox ${areaLive?.capped ? 'selbox--capped' : ''}`} style={{
              left: Math.min(areaRect.x0, areaRect.x1), top: Math.min(areaRect.y0, areaRect.y1),
              width: Math.abs(areaRect.x1 - areaRect.x0), height: Math.abs(areaRect.y1 - areaRect.y0) }}>
              <i className="selbox__c selbox__c--tl" /><i className="selbox__c selbox__c--tr" /><i className="selbox__c selbox__c--bl" /><i className="selbox__c selbox__c--br" />
              {areaLive && <span className="selbox__tag mono">{areaLive.w.toFixed(1)}′ × {areaLive.h.toFixed(1)}′{areaLive.capped ? ' · max 30′' : ''}</span>}
            </div>
          )}
          {!areaRect && <p className="area-hint">Drag a box on the sky (up to 30′ wide) · scroll to zoom · Esc or the button above to cancel</p>}
        </div>
      )}
      {areaJob && (
        <div className={`area-job ${areaJob.error ? 'area-job--error' : ''}`} role="status">
          <button className="toast__x" onClick={() => { areaRun.current++; pendingArea.current = null; setAreaJob(null); }} aria-label="Cancel">✕</button>
          <p className="area-job__title">{!areaJob.error && <span className="spinner" aria-hidden="true" />} {areaJob.title}</p>
          {!areaJob.error && <div className="area-job__bar"><i style={{ width: `${Math.round(areaJob.progress * 100)}%` }} /></div>}
          <p className="small muted">{areaJob.detail}</p>
        </div>
      )}

      {/* ---------- overlay UI ---------- */}
      <div className="skymap__top" ref={topRef}>
        {catalog?.mock && <MockBanner compact={demo} />}
        <MapSearch ref={searchRef} catalog={catalog} onHit={onSearch} />
        {/* live engine (backend/): drag a box anywhere → its SPHEREx photos open in the same popup as the targets */}
        <button className={`explore-link area-btn ${areaMode ? 'area-btn--on' : ''}`} aria-pressed={areaMode}
          onClick={() => (areaMode ? setAreaMode(false) : startAreaMode())}>
          {areaMode ? 'Cancel area selection' : 'Select an area'}
        </button>
      </div>

      <nav className="targetlist" aria-label="Objects with SPHEREx blinks">
        <p className="small">Objects with SPHEREx blinks</p>
        <ul>
          {metas.map((m) => (
            <li key={m.id}><button className="link" onClick={() => { dismissIntro(); select(m.id); }}>{m.name} — {KIND_LABEL[m.kind]}</button></li>
          ))}
        </ul>
      </nav>

      {intro && !selectedId && (
        <IntroCard onTour={startTour} onExplore={dismissIntro} onAbout={() => { setAbout(true); }} />
      )}

      {tourEnd && !selectedId && (
        <div className="toast toast--end" role="status">
          <button className="toast__x" onClick={() => setTourEnd(false)} aria-label="Dismiss">✕</button>
          <strong>{TOUR_END.title}</strong>
          <p>{TOUR_END.body}</p>
          <div className="toast__actions">
            <button className="btn" onClick={() => shareLink(window.location.origin + '/', 'SPHEREx Blink', 'site')}>
              {copied === 'site' ? 'Link copied ✓' : copied === 'site-fail' ? 'Copy failed — use the address bar' : 'Share this tool'}
            </button>
            <button className="btn btn--ghost" onClick={startTour}>Watch again</button>
          </div>
        </div>
      )}

      {hint && !selectedId && !intro && !tourEnd && (
        <p className="skymap__hint" aria-hidden="true">Drag to look around · scroll or pinch to zoom · tap a glowing marker</p>
      )}

      {!intro && (
        <div className="mapctl" role="group" aria-label="Map controls">
          {!mobile && (
            <>
              <button className="mapctl__btn" onClick={() => zoomKey(1 / 1.8)} aria-label="Zoom in (+)" title="Zoom in (+)">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
              </button>
              <button className="mapctl__btn" onClick={() => zoomKey(1.8)} aria-label="Zoom out (−)" title="Zoom out (−)">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
              </button>
            </>
          )}
          {zoomedIn && !selectedId && (
            <button className="mapctl__btn mapctl__btn--wide" onClick={() => overview()} aria-label="Zoom out to the whole sky" title="Whole sky">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
              <span>Whole sky</span>
            </button>
          )}
        </div>
      )}

      {aladinState === 'error' && view.fov < 20 && (
        <p className="skymap__offline small" role="status">Survey imagery couldn’t load (it needs the CDS Aladin service). The blink still works.</p>
      )}

      {empty && !selectedId && !areaMode && !areaJob && !emptyDismissed && (
        <div className="toast" role="status">
          <button className="toast__x" onClick={() => setEmptyDismissed(true)} aria-label="Dismiss">✕</button>
          <strong>No blink here yet</strong>
          <p>This patch hasn’t been loaded. Fetch its SPHEREx photos live from NASA (about 1–2 minutes), or draw your own area.</p>
          <p className="mono small muted">{formatRa(view.ra)} {formatDec(view.dec)}</p>
          <div className="toast__actions">
            <button className="btn" onClick={() => {
              const side = Math.min(AREA_MAX_ARCMIN, Math.max(3, view.fov * 60 * 0.5));
              runArea({ ra: view.ra, dec: view.dec, w: side, h: side });
            }}>Load SPHEREx photos here</button>
            <button className="btn btn--ghost" onClick={startAreaMode}>Select an area</button>
            {nearest && <button className="link small" onClick={() => select(nearest.id)}>or fly to {nearest.name}</button>}
          </div>
        </div>
      )}

      {notice && !selectedId && (
        <div className="toast toast--warn" role="alert">
          <button className="toast__x" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
          <strong>{notice.title}</strong>
          <p>{notice.body}</p>
        </div>
      )}

      {meta && (
        <div className={`cardstack ${sheet && mobile ? 'cardstack--open' : ''}`} ref={cardRef}>
          {tour && patchOpen && (
            <TourCard
              targetId={meta.id} kind={meta.kind} step={tourStep} onStep={setTourStep}
              order={TOUR_ORDER.filter((id) => catalog?.metas[id])}
              onTarget={selectTour} onClose={() => setTour(false)} onFinish={finishTour}
              auto={demo} paused={!ready}
              onSuggest={(s) => {
                if (s.mode) setMode(s.mode);
                if (s.band) setBand(s.band);
                if (s.spectrum) { setChartOpen(true); setChartFlash(true); window.setTimeout(() => setChartFlash(false), 2600); }
                setPlaying(true);
              }}
            />
          )}
          <section className="pcard" key={meta.id} aria-label={`${meta.name} — SPHEREx blink`}>
            {mobile && ready && (
              <button className="pcard__grab" aria-label={sheet ? 'Show less' : 'Show more about this object'} aria-expanded={sheet}
                onPointerDown={(e) => { grabY.current = e.clientY; }}
                onPointerUp={(e) => {
                  const dy = e.clientY - (grabY.current ?? e.clientY);
                  grabY.current = null;
                  if (dy < -24) setSheet(true);
                  else if (dy > 24) { if (sheet) setSheet(false); else closePatch(true); }
                  else setSheet((v) => !v);
                }}>
                <span aria-hidden="true" />
              </button>
            )}
            <header className="pcard__head">
              <div className="pcard__heading">
                <p className="eyebrow">{KIND_LABEL[meta.kind]}</p>
                <h2 className="pcard__title">{meta.name}</h2>
              </div>
              <span className="pcard__tools">
                {ready && (
                  <button className="iconbtn" onClick={() => shareLink(viewLink(), `${meta.name} — SPHEREx Blink`, 'view')} aria-label="Share this view" title="Share this view">
                    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                )}
                <button className="iconbtn" onClick={() => closePatch(true)} aria-label="Close and zoom back out to the map (Esc)" title="Back to the map (Esc)">
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
                </button>
              </span>
            </header>
            {(copied === 'view' || copied === 'view-fail') && (
              <p className="pcard__toast" role="status">{copied === 'view' ? 'Link copied — paste it anywhere to share this exact view.' : 'Copy the link from the address bar.'}</p>
            )}
            <p className="pcard__line">{copy?.oneLiner ?? `A patch of sky at ${formatRa(meta.ra_deg)} ${formatDec(meta.dec_deg)}.`}</p>

            {!ready ? (
              <div className="pcard__skeleton">
                {patchOpen && (noCoverage || load === 'empty')
                  ? <StateCard {...STATES['no-coverage']}>
                      <a className="explore-link" href={`/explore/?q=${encodeURIComponent(`${meta.ra_deg.toFixed(5)} ${meta.dec_deg.toFixed(5)}`)}`}>Fetch SPHEREx photos here (live)</a>
                    </StateCard>
                  : patchOpen && load === 'error'
                  ? <StateCard {...STATES.error} tone="warn" />
                  : <p className="pcard__status" role="status"><span className="spinner" aria-hidden="true" /> {patchOpen ? 'Loading this patch…' : 'Flying there…'}</p>}
                <span className="sk sk--controls" aria-hidden="true" />
                <span className="sk sk--line" aria-hidden="true" />
              </div>
            ) : (
              <div className="pcard__body">
                {copy && (
                  <p className="pcard__look">
                    <span className="pcard__label">Look for</span> {copy.lookFor}{' '}
                    <button className="link" onClick={doShowMe}>{HINTS.showMe}</button>
                  </p>
                )}
                <div className="pcard__controls">
                  <button
                    className="playbtn"
                    onClick={() => { if (mode === 'side') { setMode('blink'); setPlaying(true); } else setPlaying((p) => !p); }}
                    disabled={nEpochs < 2}
                    aria-label={playing && mode !== 'side' ? 'Pause (Space)' : 'Play (Space)'}
                    title={playing && mode !== 'side' ? 'Pause (Space)' : 'Play (Space)'}
                  >
                    {playing && mode !== 'side'
                      ? <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
                      : <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.2v11.6a.6.6 0 0 0 .9.5l9.2-5.8a.6.6 0 0 0 0-1L4.9 1.7a.6.6 0 0 0-.9.5Z" fill="currentColor" /></svg>}
                  </button>
                  <div className="seg" role="radiogroup" aria-label="View mode">
                    {(['blink', 'diff'] as ViewMode[]).map((m) => (
                      <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'is-on' : ''} onClick={() => setMode(m)}
                        disabled={m === 'diff' && nEpochs < 2} aria-label={MODES[m].label} title={`${MODES[m].help} (${m === 'blink' ? 'B' : 'D'})`}>
                        {MODES[m].label}
                      </button>
                    ))}
                  </div>
                  <button className={`morebtn ${sheet ? 'is-on' : ''}`} onClick={() => setSheet((v) => !v)} aria-expanded={sheet} aria-controls="more-sheet">
                    {sheet ? 'Less' : 'More'}
                  </button>
                </div>

                <VisitTimeline frames={manifest!.frames} current={frame} excluded={excluded} mode={mode}
                  onPick={(i) => { setPlaying(false); setFrame(i); }} />

                <div className="pcard__colour">
                  <span className="pcard__label">Colour</span>
                  <div className="seg seg--sm" role="radiogroup" aria-label="Infrared colour">
                    {COLOUR_STOPS.map((c) => {
                      const avail = c.bands.find((b) => entry?.bands.includes(b));
                      const on = Boolean(activeBand && c.bands.includes(activeBand));
                      return (
                        // aria-disabled, not disabled: a disabled button shows no tooltip, and this one has to say why
                        <button key={c.id} role="radio" aria-checked={on} className={on ? 'is-on' : ''} aria-disabled={!avail}
                          onClick={() => avail && setBand(avail)} aria-label={`${c.label} wavelengths, ${c.range}`}
                          title={avail ? c.range : meta?.id.startsWith('live-')
                            ? `${c.label} (${c.range}): not loaded. Areas fetched live only get the Mid colour for now.`
                            : `No ${c.label.toLowerCase()}-wavelength photos for this spot yet`}>
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                  {bandCopy && <span className="pcard__range mono">{bandCopy.range}</span>}
                </div>
                <MarkerLegend crosshair={overlayProps.crosshair && Boolean(tp)} track={overlayProps.track && trackMoves(manifest!)}
                  gaia={Boolean(overlayProps.gaia)} wise={Boolean(overlayProps.wise)}
                  firstFrame={mode !== 'diff' && nEpochs > 1}
                  mask={overlayProps.flags && mode !== 'diff' && frames?.some((f) => f.some(Number.isNaN)) ? maskCss(palette, sequenceLambda(manifest!)) : null} />

                <div className={`detsw ${detOn ? 'is-on' : ''}`}>
                  <button className="detsw__btn" role="switch" aria-checked={detOn} onClick={() => { setDetOn((v) => !v); setDetFocus(null); }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="12" r="2.6" fill="currentColor" /></svg>
                    <span>Detections</span>
                    <i className="detsw__track"><i /></i>
                  </button>
                  {detOn && det && <DetectionPanel list={det.list} pair={det.pair} known={det.known} focus={detFocus} onFocus={setDetFocus} hasReport={Boolean(report)} model={report?.ml} />}
                </div>

                {s3dParams && (
                    <>
                      <button className="s3dbtn" onClick={() => setS3d(true)} title="Artist's impression from the measured temperature, size, distance and motion">
                        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><ellipse cx="12" cy="12" rx="8" ry="3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                        View in 3D
                      </button>
                      {s3d && (
                        <Suspense fallback={<p className="pcard__status" role="status"><span className="spinner" aria-hidden="true" /> Loading 3D…</p>}>
                          <Star3D name={meta.name} p={s3dParams} onClose={closeS3d} />
                        </Suspense>
                      )}
                    </>
                )}

                {insight && (
                  <p className={`pcard__insight pcard__insight--${insight.kind}`}>
                    {insight.text}
                    {insight.kind === 'hint' && insight.text === HINTS.mover && <> <button className="link" onClick={() => setMode('diff')}>Try Difference</button></>}
                  </p>
                )}

                {chartKind && !mobile && (
                  <div className={`pcard__chart ${chartOpen ? 'is-open' : ''}`}>
                    <button className="pcard__chartbtn" onClick={() => setChartOpen((v) => !v)} aria-expanded={chartOpen}>
                      <span>{chartKind === 'lightcurve' ? 'Light curve' : 'Spectrum'}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                    {chartOpen && (
                      <MiniChart spectrum={spectrum} kind={chartKind} visit={fr?.epoch ?? frame} flash={chartFlash}
                        onOpen={() => { setSheet(true); setPanel('spectrum'); }} />
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
          {mobile && sheet && ready && <div className="pcard__more" id="more-sheet">{moreContent}</div>}
        </div>
      )}

      {!mobile && sheet && meta && ready && !about && (
        <aside id="more-sheet" className="sheet" aria-label={`More about ${meta.name}`}>{moreContent}</aside>
      )}

      {about && <AboutSheet onClose={() => setAbout(false)} mock={Boolean(catalog?.mock)} />}

      <p className="skymap__credit">
        <button className="link skymap__about" onClick={() => setAbout((a) => !a)} aria-expanded={about}>ⓘ About</button>{' · '}
        {catalog?.mock ? 'Simulated demo data · ' : 'Images: NASA/JPL-Caltech SPHEREx via IRSA · '}
        Sky imagery: <a href="https://aladin.cds.unistra.fr/" target="_blank" rel="noreferrer">Aladin Lite (CDS)</a>, {HIPS_CREDIT} · Not an official NASA product
      </p>
    </div>
  );
}
