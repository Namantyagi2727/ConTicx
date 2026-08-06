// Deterministic per-event "poster art" — a light-burst composition
// (radiating rays, concentric rings, scattered highlight dots) built
// from plain SVG, seeded from the event id. Stands in for real
// photography/illustration, which this prototype doesn't have: two
// events with the same spot color still get visibly different
// compositions, and a given event always renders the same way rather
// than reshuffling on every request.

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// mulberry32 — small, fast, deterministic PRNG. We just need several
// independent-looking values per event, not cryptographic quality.
function mulberry32(seed: number) {
  let state = seed;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function PosterArt({
  seed,
  className,
}: {
  seed: string;
  className?: string;
}) {
  const random = mulberry32(hashString(seed));

  const width = 400;
  const height = 220;
  const focusX = width * (0.55 + random() * 0.35);
  const focusY = height * (0.15 + random() * 0.35);

  const rayCount = 16 + Math.floor(random() * 12);
  const rays = Array.from({ length: rayCount }, (_, i) => {
    const angle = (i / rayCount) * Math.PI * 2 + random() * 0.4;
    const length = 100 + random() * 260;
    return {
      x2: focusX + Math.cos(angle) * length,
      y2: focusY + Math.sin(angle) * length,
      opacity: 0.06 + random() * 0.2,
    };
  });

  const ringCount = 2 + Math.floor(random() * 2);
  const rings = Array.from({ length: ringCount }, (_, i) => ({
    r: 26 + i * (16 + random() * 16),
    opacity: 0.5 - i * 0.13,
  }));

  const dotCount = 12 + Math.floor(random() * 10);
  const dots = Array.from({ length: dotCount }, () => ({
    x: random() * width,
    y: random() * height,
    r: 1 + random() * 2.2,
    opacity: 0.25 + random() * 0.4,
  }));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      className={className}
      aria-hidden
    >
      {rays.map((ray, i) => (
        <line
          key={`ray-${i}`}
          x1={focusX}
          y1={focusY}
          x2={ray.x2}
          y2={ray.y2}
          stroke="currentColor"
          strokeWidth={1}
          opacity={ray.opacity}
        />
      ))}
      {rings.map((ring, i) => (
        <circle
          key={`ring-${i}`}
          cx={focusX}
          cy={focusY}
          r={ring.r}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          opacity={ring.opacity}
        />
      ))}
      {dots.map((dot, i) => (
        <circle
          key={`dot-${i}`}
          cx={dot.x}
          cy={dot.y}
          r={dot.r}
          fill="currentColor"
          opacity={dot.opacity}
        />
      ))}
      <circle cx={focusX} cy={focusY} r={4} fill="currentColor" opacity={0.9} />
    </svg>
  );
}
