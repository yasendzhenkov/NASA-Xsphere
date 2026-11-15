import { INTRO, PRODUCT, VIDEOS } from '../copy';
import { BlinkMark } from '../components/Chrome';

/** First-visit story card over the overview map: why this matters + two ways in. */
export function IntroCard({ onTour, onExplore, onAbout }: { onTour: () => void; onExplore: () => void; onAbout: () => void }) {
  return (
    <section className="intro" aria-labelledby="intro-h" onPointerDown={(e) => e.stopPropagation()}>
      <p className="eyebrow">{INTRO.eyebrow}</p>
      <h1 id="intro-h" className="intro__title"><BlinkMark /> {PRODUCT.tagline}</h1>
      <p className="intro__body">{INTRO.body}</p>
      <div className="intro__actions">
        <button className="btn intro__primary" onClick={onTour} autoFocus>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.2v11.6a.6.6 0 0 0 .9.5l9.2-5.8a.6.6 0 0 0 0-1L4.9 1.7a.6.6 0 0 0-.9.5Z" fill="currentColor" /></svg>
          {INTRO.tour}
        </button>
        <button className="btn btn--ghost" onClick={onExplore}>{INTRO.explore}</button>
      </div>
      <p className="videolinks small">{VIDEOS.map((v) => <a key={v.href} href={v.href} target="_blank" rel="noreferrer">{v.label}</a>)}</p>
      <button className="link small intro__about" onClick={onAbout}>About this project and the data</button>
    </section>
  );
}
