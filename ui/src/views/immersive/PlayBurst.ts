/**
 * Play accent (Track L): a bloom and a ring of sparks from the Play button, the instant before
 * the launch portal opens. Plain DOM + CSS keyframes (transform/opacity only), removed after
 * ~0.9 s. Nothing under reduced motion, Low quality, Performance Mode or High contrast.
 */
const SPARKS = 16;

/** Spark directions: evenly spread with a fixed jitter (deterministic, so it never looks random-cheap). */
export function sparkVectors(n = SPARKS): { x: number; y: number; delay: number; size: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + (i % 2 ? 0.12 : -0.08);
    const dist = 70 + ((i * 37) % 5) * 14;
    return { x: Math.round(Math.cos(a) * dist), y: Math.round(Math.sin(a) * dist), delay: (i % 4) * 18, size: 4 + (i % 3) * 2 };
  });
}

export function playBurst(from: Element) {
  const root = document.documentElement.dataset;
  if (root.reducedMotion === 'true' || root.quality === 'low' || root.performance === 'true' || root.theme === 'contrast') return;
  const r = from.getBoundingClientRect();
  const host = document.createElement('div');
  host.className = 'imm-burst';
  host.setAttribute('aria-hidden', 'true');
  host.style.left = `${r.left + r.width / 2}px`;
  host.style.top = `${r.top + r.height / 2}px`;
  const bloom = document.createElement('span');
  bloom.className = 'imm-burst__bloom';
  host.appendChild(bloom);
  for (const v of sparkVectors()) {
    const s = document.createElement('span');
    s.className = 'imm-burst__spark';
    s.style.setProperty('--dx', `${v.x}px`);
    s.style.setProperty('--dy', `${v.y}px`);
    s.style.setProperty('--d', `${v.delay}ms`);
    s.style.setProperty('--s', `${v.size}px`);
    host.appendChild(s);
  }
  document.body.appendChild(host);
  window.setTimeout(() => host.remove(), 950);
}
