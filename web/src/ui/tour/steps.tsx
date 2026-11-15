import type { ReactNode } from 'react';

/**
 * The 14-step onboarding tour. The tour drives the real app by clicking its own controls
 * (no extra state plumbing into SkyMap), so a renamed control only makes that step skip itself.
 */
export type TourStep = {
  title: string;
  body: ReactNode;
  example?: ReactNode;
  /** CSS selectors; the first one that exists is spotlit. No target = centred card. */
  target?: string[];
  /** Extra elements merged into the spotlight box. */
  also?: string[];
  /** Runs before the target is looked up. Must never throw into the app. */
  action?: (ctx: { mobile: boolean }) => Promise<void> | void;
  /** Leave focus where the action put it (e.g. the search box). */
  keepFocus?: boolean;
  final?: boolean;
};

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Poll for an element for up to `ms`. */
export async function waitFor(selectors: string[], ms = 4000): Promise<HTMLElement | null> {
  const t0 = performance.now();
  for (;;) {
    for (const s of selectors) {
      const el = document.querySelector<HTMLElement>(s);
      if (el && el.getClientRects().length) return el;
    }
    if (performance.now() - t0 > ms) return null;
    await sleep(100);
  }
}

const click = (sel: string) => document.querySelector<HTMLElement>(sel)?.click();

/** Open one of the prepared objects through the app's own (screen-reader) object list, then wait for its controls. */
async function openObject(name: string) {
  const title = document.querySelector('.pcard__title')?.textContent ?? '';
  if (!title.startsWith(name) || !document.querySelector('.pcard__controls')) {
    const btn = [...document.querySelectorAll<HTMLButtonElement>('.targetlist button')].find((b) => b.textContent?.startsWith(name));
    btn?.click();
  }
  // first open flies the map and loads the frames; the old object's controls may still be on screen meanwhile
  const t0 = performance.now();
  while (performance.now() - t0 < 9000) {
    if ((document.querySelector('.pcard__title')?.textContent ?? '').startsWith(name) && document.querySelector('.pcard__controls')) return;
    await sleep(100);
  }
}

export function closeStar3D() {
  click('.s3d .s3d__head .iconbtn');
}

export const STEPS: TourStep[] = [
  {
    title: 'What this is',
    body: <>NASA’s SPHEREx photographs the whole sky every 6 months in 102 infrared colours. This app flips through those photos so you can see what moves — the same blink trick that found Pluto in 1930.</>,
  },
  {
    title: 'Search',
    body: <>Type a star name (typos are fine) or sky coordinates.</>,
    example: <>Try <b>barnards star</b> or <b className="mono">269.45 4.69</b>.</>,
    target: ['.msearch'],
  },
  {
    title: 'The 5 test targets',
    body: (
      <>
        The objects NASA’s challenge asked us to test:
        <ul className="otour__list">
          <li><b>Barnard’s Star</b> — the fastest-moving star on our sky.</li>
          <li><b>ε Indi B</b> — two brown dwarfs orbiting a nearby star, moving together.</li>
          <li><b>WISE 0855−0714</b> — the coldest known brown dwarf.</li>
          <li><b>RW Aurigae</b> — a young star that dims as dust passes in front of it.</li>
          <li><b>R Draconis</b> — a pulsating giant that swells and fades over months.</li>
        </ul>
      </>
    ),
    // desktop: open the search list, which shows the five; on phones focusing would pop up the keyboard
    action: ({ mobile }) => { if (!mobile) document.querySelector<HTMLInputElement>('#map-search')?.focus(); },
    target: ['.msearch__list', '.msearch'],
    keepFocus: true,
  },
  {
    title: 'Blink, play/pause and the visit timeline',
    body: <>Play flips through the visits; tap a dot on the timeline to stop on one. Barnard’s Star moves 10.4″ a year: about 1–2 SPHEREx pixels (6.15″ each) between visits.</>,
    example: <>Watch the ring on the map.</>,
    action: async () => {
      await openObject('Barnard');
      click('.pcard__look .link'); // “Show me”: ring + path on the star
    },
    target: ['.pcard__controls'],
    also: ['.vtl'],
  },
  {
    title: 'Motion line and markers',
    body: (
      <ul className="otour__list">
        <li>Thin white path, a ring per visit: where the star was each time.</li>
        <li>Yellow crosshair: the position the catalogue predicts.</li>
        <li>Dashed border: the first visit of the loop.</li>
        <li>Blue: no usable data there (e.g. saturated).</li>
      </ul>
    ),
    action: () => openObject('Barnard'),
    target: ['.mlegend'],
  },
  {
    title: 'Blink, Difference and Side by side',
    body: <>Difference subtracts the previous visit: still stars turn grey, and a mover leaves a dark/bright pair. Side by side (key <kbd>S</kbd>) lays the visits next to each other.</>,
    example: <>Switched to Difference: look for the dark/bright pair at Barnard’s Star.</>,
    action: async () => {
      await openObject('Barnard');
      const b = [...document.querySelectorAll<HTMLButtonElement>('.seg[aria-label="View mode"] button')].find((x) => x.textContent === 'Difference');
      if (b && b.getAttribute('aria-checked') !== 'true') b.click();
    },
    target: ['.seg[aria-label="View mode"]'],
  },
  {
    title: 'Short, Mid and Long colours',
    body: <>Each button shows a different slice of the infrared. WISE 0855, the coldest known brown dwarf, is invisible in Short and appears in Long (3.8–5 µm).</>,
    example: <>Areas fetched live only load the Mid colour for now.</>,
    action: async () => {
      await openObject('Barnard');
      const b = [...document.querySelectorAll<HTMLButtonElement>('.seg[aria-label="View mode"] button')].find((x) => x.textContent === 'Blink');
      if (b && b.getAttribute('aria-checked') !== 'true') b.click();
    },
    target: ['.pcard__colour'],
  },
  {
    title: 'Detections',
    body: <>Movers, variables and unmatched sources, checked against Gaia DR3, CatWISE, AllWISE, 2MASS and known asteroids (SkyBoT).</>,
    example: <>“Candidate” means a human still has to check it.</>,
    action: async () => {
      await openObject('Barnard');
      const b = document.querySelector<HTMLElement>('.detsw__btn');
      if (b && b.getAttribute('aria-checked') !== 'true') b.click();
      await waitFor(['.detp'], 2000);
    },
    target: ['.detsw'],
  },
  {
    title: 'The model line',
    body: <>Our own triage model gives a second opinion. On sky it never saw it is 93.1 % correct vs a 65.7 % baseline; trained on 9,427 objects in 43 zones. <b>Check first</b> sorts the oddest first.</>,
    example: <span className="mono">Model: star · 97 % · oddness top 3 %</span>,
    target: ['.detp__ml', '.detp__meta'],
  },
  {
    title: 'Light curve and spectrum',
    body: <>R Draconis brightens and dims over months: the light curve follows it visit by visit. The spectrum is its brightness at each wavelength.</>,
    action: async ({ mobile }) => {
      await openObject('R Draconis');
      if (mobile) { if (!document.querySelector('.pcard__more')) click('.morebtn'); }
      else if (!document.querySelector('.pcard__chart.is-open')) click('.pcard__chartbtn');
    },
    target: ['.pcard__chart', '.pcard__more .minichart', '.pcard__more'],
  },
  {
    title: 'View in 3D',
    body: <>An artist’s impression built from the measured temperature, size, distance and motion. Not a photo.</>,
    action: async () => {
      if (!document.querySelector('.s3dbtn')) await openObject('Barnard');
      click('.s3dbtn');
      await waitFor(['.s3d__view'], 4000); // lazy-loaded: wait here, or the button behind it would be spotlit
    },
    target: ['.s3d__view', '.s3d'],
  },
  {
    title: 'Select an area',
    body: <>Draw a box anywhere and the server pulls every NASA photo of it. The photo grid then shows one outline per SPHEREx photo, one colour per visit.</>,
    example: <>Each photo is about 3.5° wide, so zoom out to about 5° to see the whole grid. Outlines appear once the photos are loaded.</>,
    target: ['.area-btn'],
  },
  {
    title: 'Share and embed',
    body: <>The link always encodes your exact view: object, mode, colour and zoom. <b>More → Share / embed</b> gives a snippet for any web page.</>,
    target: ['button[aria-label="Share this view"]', '.pcard__tools'],
  },
  {
    title: 'What a real find would look like',
    body: (
      <ul className="otour__list">
        <li>It moves consistently across 2–3 visits.</li>
        <li>It matches no catalogue.</li>
        <li>It isn’t at a photo edge.</li>
      </ul>
    ),
    example: <>Found a candidate like that? Report it to <a href="https://backyardworlds.org" target="_blank" rel="noreferrer">Backyard Worlds</a>.</>,
    final: true,
  },
];
