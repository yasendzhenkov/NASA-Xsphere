/**
 * All user-facing words in one place (Product owns copy; D13: say "candidate", never "discovery").
 *
 * ⚠️ TARGET FACTS ARE PLACEHOLDERS until Data delivers data/science-notes.md (C7).
 *    Every number shown in the UI or video must trace back to C7. Items marked `verify: true`
 *    must be checked by Sean/Yasen and replaced with the C7 wording + source link.
 */
import type { BandId } from './lib/contracts';

export const PRODUCT = {
  name: 'SPHEREx Blink',
  tagline: 'Watch the infrared sky move.',
  pitch:
    'Type a star’s name or sky coordinates. See the same patch of sky at every SPHEREx visit, blinking like a little video — moving and changing objects jump out.',
  heritage: 'In 1930, Clyde Tombaugh found Pluto by blinking two photographs. This is that blink comparator, for NASA’s newest all-sky survey.',
};

export interface BandCopy {
  id: BandId;
  label: string;
  range: string;
  plain: string;
}

/** SPHEREx detector windows (µm). Data's bands.json (D-5) is authoritative — swap in when it lands. */
export const BANDS: BandCopy[] = [
  { id: 'D1', label: 'D1', range: '0.75–1.09 µm', plain: 'Nearest to visible red light' },
  { id: 'D2', label: 'D2', range: '1.10–1.62 µm', plain: 'Where most stars shine brightest' },
  { id: 'D3', label: 'D3', range: '1.63–2.41 µm', plain: 'Sees through dust' },
  { id: 'D4', label: 'D4', range: '2.42–3.82 µm', plain: 'Water ice and methane absorb here' },
  { id: 'D5', label: 'D5', range: '3.83–4.41 µm', plain: 'Carbon dioxide ice band' },
  { id: 'D6', label: 'D6', range: '4.42–5.00 µm', plain: 'Longest wavelengths SPHEREx sees' },
  { id: 'D56', label: '3.8–5 µm', range: '3.8–5.0 µm', plain: 'Where cold brown dwarfs glow' },
];

export const MODES = {
  blink: { label: 'Blink', help: 'Flip between visits. Anything that jumps has moved; anything that pulses has changed brightness.' },
  diff: { label: 'Difference', help: 'Later visit minus earlier. Still stars vanish to grey. A mover shows as a dark–bright pair (a “dipole”).' },
  side: { label: 'Side by side', help: 'All visits next to each other, nothing flashing.' },
} as const;

export const STATES = {
  loading: { title: 'Fetching the sky…', body: 'Loading the SPHEREx frames for this patch.' },
  'one-epoch': {
    title: 'Only one visit so far',
    body: 'SPHEREx has photographed this patch once. It maps the whole sky every six months — come back after its next pass to see what moved.',
  },
  'two-epochs': {
    title: 'Two visits',
    body: 'Two snapshots so far: blink and difference work, but the motion track is just a straight line between them.',
  },
  'no-coverage': {
    title: 'No SPHEREx images here yet',
    body: 'This patch is not in the data releases we loaded. Try one of the demo targets, or check back after the next release.',
  },
  'saturated-target': {
    title: 'Very bright target',
    body: 'This star is so bright that the detector saturates at its centre (shown as “problem pixels”). Try Difference mode or the longest-wavelength band.',
  },
  'name-not-found': {
    title: 'We couldn’t find that name',
    body: 'Try a demo target below, or type coordinates like “269.45 4.74” or “08h55m10.8s −7d14m42s”.',
  },
  'live-not-available': {
    title: 'Not processed yet',
    body: 'This demo shows pre-processed targets only, so it stays fast for everyone. Pick a demo target, or open this position in IRSA to look at the raw images.',
  },
  error: { title: 'Something went wrong', body: 'We couldn’t load this view. Try reloading, or pick another target.' },
} as const;

export interface TargetCopy {
  oneLiner: string;
  facts: { text: string; verify?: boolean }[];
  lookFor: string;
  bestBand: string;
  tour: [string, string, string]; // what it is → what to look for → did you see it?
}

export const TARGET_COPY: Record<string, TargetCopy> = {
  'barnards-star': {
    oneLiner: 'A small red star racing across our sky.',
    facts: [
      { text: 'One of the closest stars to the Sun, about 6 light-years away.', verify: true },
      { text: 'It has the fastest apparent motion of any star: about 10 arcseconds per year.', verify: true },
      { text: 'Very bright in the infrared, so its centre saturates the detector.', verify: true },
    ],
    lookFor: 'The star at the crosshair shifts a pixel or two to the north between visits.',
    bestBand: 'Longest wavelengths (D6) or Difference mode, because the core is saturated.',
    tour: [
      'Barnard’s Star is one of our nearest neighbours — and the fastest-moving star on the sky.',
      'Watch the star under the crosshair. Switch to Difference: a dark–bright pair means it moved.',
      'Did you see it hop north? That is a few months of a star’s journey around the Galaxy.',
    ],
  },
  'eps-indi-b': {
    oneLiner: 'Two brown dwarfs orbiting a nearby star, moving together.',
    facts: [
      { text: 'ε Indi B is a pair of brown dwarfs — too heavy to be planets, too light to burn like stars.', verify: true },
      { text: 'They orbit the star ε Indi A, about 12 light-years from us.', verify: true },
      { text: 'The whole system moves across the sky by several arcseconds a year.', verify: true },
    ],
    lookFor: 'A faint red dot that shifts between visits, while background stars stay put.',
    bestBand: '3.8–5 µm, where cold brown dwarfs are brightest.',
    tour: [
      'ε Indi B: two “failed stars” circling each other and a nearby Sun-like star.',
      'Pick the 3.8–5 µm band. Find the dot that moves while the stars around it do not.',
      'Seen it? Volunteers have found thousands of brown dwarfs exactly like this.',
    ],
  },
  'wise-0855': {
    oneLiner: 'The coldest known brown dwarf — invisible except in the deep infrared.',
    facts: [
      { text: 'WISE 0855−0714 is one of the closest objects to the Sun, about 7 light-years away.', verify: true },
      { text: 'It is colder than the North Pole in winter — near the temperature of a freezer.', verify: true },
      { text: 'It only shows up at the longest SPHEREx wavelengths (3.8–5 µm).', verify: true },
    ],
    lookFor: 'Switch bands: nothing at short wavelengths, a faint moving dot at 3.8–5 µm.',
    bestBand: '3.8–5 µm (co-added). In shorter bands it is invisible.',
    tour: [
      'WISE 0855 is so cold it barely glows — it was found only in 2014.',
      'Try D1, then 3.8–5 µm. It appears only at the longest wavelengths. Then watch it move.',
      'You just saw a world colder than ice, a few light-years away. Check its spectrum for water and methane.',
    ],
  },
  'rw-aurigae': {
    oneLiner: 'A young star that dims and brightens as dust passes in front of it.',
    facts: [
      { text: 'RW Aurigae is a young star system, still surrounded by the disc it formed from.', verify: true },
      { text: 'Its brightness changes irregularly when clumps of dust block its light.', verify: true },
      { text: 'It does not move noticeably — what changes is its brightness.', verify: true },
    ],
    lookFor: 'The star stays in place but gets brighter or fainter between visits.',
    bestBand: 'Any band; compare short and long wavelengths.',
    tour: [
      'RW Aurigae is a baby star, a few million years old.',
      'This time nothing moves. Watch the brightness of the star at the crosshair instead.',
      'Brightening or fading? Dust in its disc is changing what reaches us.',
    ],
  },
  'r-draconis': {
    oneLiner: 'A pulsating giant star that swells and fades over months.',
    facts: [
      { text: 'R Draconis is a “Mira” variable: an old giant star that pulsates.', verify: true },
      { text: 'Its brightness rises and falls over a cycle of roughly 8 months.', verify: true },
      { text: 'It sits near the north ecliptic pole, where SPHEREx looks about every month.', verify: true },
    ],
    lookFor: 'The star pulses in brightness from month to month — the light curve in the card shows the rhythm.',
    bestBand: 'Any band. Many visits → the best light curve of the five.',
    tour: [
      'R Draconis is an ageing giant star, breathing in and out.',
      'Play the blink: SPHEREx sees this spot almost every month, so you get a real movie.',
      'Did it pulse? Open Spectrum → Light curve to see the rhythm.',
    ],
  },
};

export const KIND_LABEL = {
  mover: 'Fast-moving star',
  variable: 'Variable star',
  'companion-mover': 'Brown dwarf pair',
  custom: 'Your coordinates',
} as const;

export const MOLECULES = [
  { id: 'H2O', label: 'H₂O', um: [2.7, 3.0] as [number, number], plain: 'Water' },
  { id: 'CH4', label: 'CH₄', um: [3.2, 3.5] as [number, number], plain: 'Methane' },
  { id: 'CO2', label: 'CO₂', um: [4.2, 4.35] as [number, number], plain: 'Carbon dioxide' },
  { id: 'CO', label: 'CO', um: [4.5, 4.8] as [number, number], plain: 'Carbon monoxide' },
] as const;

export const FLAG_LEGEND_FALLBACK = [
  { name: 'OVERFLOW', plain: 'Too bright: the detector saturated here.' },
  { name: 'SOURCE', plain: 'A known star or galaxy sits on this pixel.' },
  { name: 'BLOOM', plain: 'Light bleeding from a very bright star.' },
];

// ---------------------------------------------------------------------------------------------
// Map-first experience: intro, tour ending, hints, quick colour stops, About sheet.
// ---------------------------------------------------------------------------------------------

export const INTRO = {
  eyebrow: 'NASA SPHEREx · 102 infrared colours · whole sky every 6 months',
  body:
    'In 1930, Clyde Tombaugh found Pluto by blinking two photographs. Do the same with NASA’s newest infrared sky survey: fly to a glowing marker and watch stars move and change.',
  tour: 'Take the 60-second tour',
  explore: 'Explore on my own',
};

export const TOUR_END = {
  title: 'Your browser is a blink comparator.',
  body: 'You just watched five objects move and change. Search for one again, share what you saw, or flag a candidate.',
};

export const HINTS = {
  mover: 'Hard to see? Try Difference — a moving star becomes a dark–bright pair.',
  variable: 'Here nothing moves. Watch the brightness of the star under the crosshair.',
  shared: 'Someone shared this view with you. Watch the star under the crosshair.',
  showMe: 'Show me',
};

/** One-tap colour switch in the card. `bands` are tried in order; the first one the bundle has is used. */
export const COLOUR_STOPS: { id: 'short' | 'mid' | 'long'; label: string; range: string; bands: BandId[] }[] = [
  { id: 'short', label: 'Short', range: '0.75–1.6 µm', bands: ['D1', 'D2'] },
  { id: 'mid', label: 'Mid', range: '1.6–3.8 µm', bands: ['D3', 'D4'] },
  { id: 'long', label: 'Long', range: '3.8–5 µm', bands: ['D56', 'D6', 'D5'] },
];

/**
 * About sheet + submission page (keep in sync with submission/project-texts.md).
 * ⚠️ Facts marked verify must be checked against C7 / the sources before submission.
 */
export const ABOUT = {
  title: 'About SPHEREx Blink',
  what:
    'A public, no-login web tool that shows the same patch of sky at every SPHEREx visit, one after another, so moving and changing objects stand out — the same “blink” trick astronomers have used since 1930.',
  how: [
    'Every patch is cut out of SPHEREx spectral images at the same infrared colour for every visit, so a change in the loop is real motion or brightness, not a colour change.',
    'Difference mode subtracts one visit from the next: still stars vanish, a mover leaves a dark–bright pair.',
    'The sky behind each patch is an older survey (DSS2), so you can also see where fast stars were decades ago.',
  ],
  facts: [
    { text: 'SPHEREx launched in March 2025 and maps the whole sky every six months.', verify: true },
    { text: 'It splits light into 102 infrared colours: 6 detectors × 17 bands, 0.75–5 µm.', verify: true },
    { text: 'Each pixel covers 6.15 arcseconds of sky.', verify: true },
  ],
  data: [
    { label: 'NASA SPHEREx spectral images (IRSA)', href: 'https://irsa.ipac.caltech.edu/Missions/spherex.html' },
    { label: 'SPHEREx data products documentation', href: 'https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products' },
    { label: 'ESA Gaia DR3 positions and motions', href: 'https://www.cosmos.esa.int/web/gaia/dr3' },
    { label: 'DSS2 colour sky via CDS HiPS (IRSA mirror)', href: 'https://aladin.cds.unistra.fr/hips/list' },
    { label: 'Aladin Lite v3 (CDS, Strasbourg)', href: 'https://aladin.cds.unistra.fr/AladinLite/' },
  ],
  references: [
    { label: 'Space Apps 2026 challenge: Planet X and SPHEREx', href: 'https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/' },
    { label: 'WiseView (the model for this tool)', href: 'http://byw.tools/wiseview' },
    { label: 'Backyard Worlds: Planet 9 (Kuchner et al. 2017)', href: 'https://ar5iv.arxiv.org/html/1705.02919' },
    { label: 'Clyde Tombaugh and the discovery of Pluto (Britannica)', href: 'https://www.britannica.com/biography/Clyde-Tombaugh' },
    { label: 'WCAG 2.3.1 — no more than three flashes per second', href: 'https://kb.daisy.org/publishing/docs/wcag/three-flashes-or-below-threshold.html' },
  ],
  si: 'Draft — team to confirm: parts of the code were written with an AI coding assistant and reviewed by the team. No AI-generated images or video are used; any added later will carry a visible watermark.',
  legal: 'Built for the NASA Space Apps Challenge 2026. Not an official NASA product. No NASA logos are used.',
};

/** Explainer film + short demo, hosted with the submission. */
export const VIDEOS = [
  { label: '▶ Watch the 2-minute explainer', href: 'https://spherex-blink-demo.vercel.app/#explainer' },
  { label: '30-second demo', href: 'https://spherex-blink-demo.vercel.app/' },
];
