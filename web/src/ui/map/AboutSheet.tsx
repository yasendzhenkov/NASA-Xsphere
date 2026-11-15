import { ABOUT, PRODUCT, VIDEOS } from '../copy';

/** About / data / references / SI disclosure — the trust layer judges look for (Relevance, Presentation). */
export function AboutSheet({ onClose, mock }: { onClose: () => void; mock: boolean }) {
  return (
    <aside className="sheet sheet--about" aria-labelledby="about-h" onPointerDown={(e) => e.stopPropagation()}>
      <div className="sheet__head">
        <h2 id="about-h">{ABOUT.title}</h2>
        <button className="pcard__x" onClick={onClose} aria-label="Close About">✕</button>
      </div>
      <p>{ABOUT.what}</p>
      <p className="videolinks small">{VIDEOS.map((v) => <a key={v.href} href={v.href} target="_blank" rel="noreferrer">{v.label}</a>)}</p>
      {mock && <p className="pcard__note small">The images here are simulated until the team’s real SPHEREx cut-outs are published.</p>}

      <section className="sheet__sec">
        <h3>How it works</h3>
        <ul className="about__list">{ABOUT.how.map((t) => <li key={t}>{t}</li>)}</ul>
      </section>

      <section className="sheet__sec">
        <h3>The mission</h3>
        <ul className="about__list">
          {ABOUT.facts.map((f) => <li key={f.text}>{f.text}{f.verify && <span className="draft-tag" title="To be checked against the team’s science notes (C7)">draft</span>}</li>)}
        </ul>
        <p className="small muted">{PRODUCT.heritage}</p>
      </section>

      <section className="sheet__sec">
        <h3>Data</h3>
        <ul className="about__links">{ABOUT.data.map((d) => <li key={d.href}><a href={d.href} target="_blank" rel="noreferrer">{d.label} ↗</a></li>)}</ul>
      </section>

      <section className="sheet__sec">
        <h3>References</h3>
        <ul className="about__links">{ABOUT.references.map((d) => <li key={d.href}><a href={d.href} target="_blank" rel="noreferrer">{d.label} ↗</a></li>)}</ul>
      </section>

      <section className="sheet__sec">
        <h3>Use of AI</h3>
        <p className="small">{ABOUT.si}</p>
      </section>

      <p className="small muted">{ABOUT.legal}</p>
    </aside>
  );
}
