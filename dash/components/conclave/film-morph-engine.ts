/** Seekable 15-second film choreography. Every pose comes from media time. */
export const FILM_MORPH_DURATION = 15;
export const FILM_MORPH_STILL_TIME = 12.8;
export type FilmPanel =
  | 'question'
  | 'perspectives'
  | 'compare'
  | 'dissent'
  | 'direction';
type Key = { at: number; value: number };
export type FilmMorphFrame = {
  time: number;
  state: FilmPanel | 'reset';
  phase: number;
  compact: boolean;
  width: number;
  height: number;
  shape: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
  };
  panels: { id: FilmPanel; opacity: number; blur: number; y: number }[];
  nodes: { x: number; y: number; opacity: number; radius: number }[];
  tabs: { left: number; right: number };
  rows: number[];
  drag: number;
  kept: number;
  branches: number[];
  brief: number;
  cursor: {
    x: number;
    y: number;
    opacity: number;
    scale: number;
    ring: number;
    ringOpacity: number;
  };
};

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const mix = (a: number, b: number, n: number) => a + (b - a) * n;
const ease = (start: number, end: number, t: number) => {
  const p = clamp((t - start) / (end - start));
  return p * p * (3 - 2 * p);
};

export function filmSpringStep(seconds: number) {
  if (seconds <= 0) return 0;
  if (seconds >= 1) return 1;
  const frequency = 23;
  const damping = 0.92;
  const decay = damping * frequency;
  const oscillation = frequency * Math.sqrt(1 - damping * damping);
  return (
    1 -
    Math.exp(-decay * seconds) *
      (Math.cos(oscillation * seconds) +
        (decay / oscillation) * Math.sin(oscillation * seconds))
  );
}

export function wrapFilmMorphTime(seconds: number) {
  if (!Number.isFinite(seconds)) return 0;
  return (
    ((seconds % FILM_MORPH_DURATION) + FILM_MORPH_DURATION) %
    FILM_MORPH_DURATION
  );
}

/** Summed periodic target changes retain velocity across every interior cue. */
function track(keys: Key[], time: number, delay = 0) {
  let value = keys[keys.length - 1].value;
  for (const loop of [-1, 0]) {
    keys.forEach((key, index) => {
      const previous = keys[(index + keys.length - 1) % keys.length];
      value +=
        (key.value - previous.value) *
        filmSpringStep(time - key.at - delay - loop * FILM_MORPH_DURATION);
    });
  }
  return value;
}

const PANELS: FilmPanel[] = [
  'question',
  'perspectives',
  'compare',
  'dissent',
  'direction',
];
const CUES: { at: number; id: FilmPanel }[] = [
  { at: 0, id: 'question' },
  { at: 2, id: 'perspectives' },
  { at: 5, id: 'compare' },
  { at: 8, id: 'dissent' },
  { at: 10.5, id: 'direction' },
  { at: 13.5, id: 'question' },
];

export function seekFilmMorph(
  seconds: number,
  measuredWidth = 410,
): FilmMorphFrame {
  const time = wrapFilmMorphTime(seconds);
  const width = Math.max(
    220,
    Math.min(410, Number.isFinite(measuredWidth) ? measuredWidth : 410),
  );
  const compact = width < 340;
  const height = compact ? 150 : 268;
  const maxWidth = width - 2;
  const widths = [
    maxWidth * 0.94,
    maxWidth,
    maxWidth,
    maxWidth * 0.97,
    maxWidth * 0.95,
    maxWidth * 0.94,
  ];
  const heights = compact
    ? [75, 134, 148, 140, 146, 75]
    : [92, 208, 250, 199, 234, 92];
  const radii = compact ? [13, 16, 14, 19, 12, 13] : [17, 21, 18, 25, 14, 17];
  const makeTrack = (values: number[]) =>
    CUES.slice(1).map((cue, i) => ({ at: cue.at, value: values[i + 1] }));
  const shape = {
    x: 1,
    y: 1,
    width: track(makeTrack(widths), time),
    height: track(makeTrack(heights), time),
    radius: track(makeTrack(radii), time),
  };
  let cueIndex = 0;
  CUES.forEach((cue, index) => {
    if (time >= cue.at) cueIndex = index;
  });
  const current = CUES[cueIndex];
  const previous = CUES[Math.max(0, cueIndex - 1)];
  const age = time - current.at;
  const entering = cueIndex === 0 ? 1 : ease(0.13, 0.38, age);
  const outgoing = cueIndex === 0 ? 0 : 1 - ease(0, 0.105, age);
  const panels = PANELS.map((id) => {
    const opacity =
      id === current.id ? entering : id === previous.id ? outgoing : 0;
    const leaving = id === previous.id && id !== current.id;
    return {
      id,
      opacity,
      blur: (1 - opacity) * 2.4,
      y: (1 - opacity) * (leaving ? -4 : 5),
    };
  });

  const margin = compact ? 14 : 21;
  const tabWidth = (maxWidth - margin * 2) / 4;
  const tabsY = compact ? 61 : 89;
  const rowFirst = compact ? 55 : 82;
  const rowGap = compact ? 25 : 43;
  const cardY = compact ? 49 : 64;
  const keepY = compact ? 101 : 143;
  const nodeX = compact ? 25 : 33;
  const nodes = [0, 1, 2, 3].map((i) => {
    const keys = [
      { at: 2.11, x: margin + tabWidth * (i + 0.5), y: tabsY, opacity: 1 },
      { at: 5.08, x: nodeX, y: rowFirst + rowGap * i, opacity: 1 },
      { at: 8.06, x: nodeX, y: cardY + 15, opacity: i === 3 ? 1 : 0 },
      { at: 8.84, x: nodeX + 4, y: keepY, opacity: i === 3 ? 1 : 0 },
      {
        at: 10.56,
        x: compact ? 26 : 33,
        y: compact ? 49 + i * 21 : 76 + i * 32,
        opacity: 1,
      },
      { at: 13.56, x: widths[0] - 29, y: compact ? 51 : 49, opacity: 0 },
    ];
    const value = (property: 'x' | 'y' | 'opacity') =>
      track(
        keys.map((key) => ({ at: key.at, value: key[property] })),
        time,
      );
    return {
      x: value('x'),
      y: value('y'),
      opacity: clamp(value('opacity')),
      radius: compact ? 8 : 11,
    };
  });

  // The leading edge advances first; the trailing edge catches up 45ms later.
  const selectedTab = [
    { at: 2.2, value: 0 },
    { at: 2.95, value: 1 },
    { at: 3.65, value: 2 },
    { at: 4.35, value: 3 },
    { at: 13.5, value: 0 },
  ];
  const edgeKeys = (edge: 'left' | 'right') =>
    selectedTab.map((key, index) => {
      const previous =
        selectedTab[(index + selectedTab.length - 1) % selectedTab.length];
      const movingRight = key.value > previous.value;
      const lag = edge === 'left' ? movingRight : !movingRight;
      return { at: key.at + (lag ? 0.045 : 0), value: key.value };
    });
  const left = margin + track(edgeKeys('left'), time) * tabWidth + 2;
  const right =
    margin + track(edgeKeys('right'), time) * tabWidth + tabWidth - 2;
  const drag = clamp(filmSpringStep(time - 8.84));
  const kept = ease(9.35, 9.62, time) * (1 - ease(10.48, 10.58, time));
  const branches = [0, 1, 2, 3].map((i) =>
    ease(10.75 + i * 0.11, 11.55 + i * 0.11, time),
  );

  const home = { x: widths[0] - 12, y: heights[0] + 9 };
  const cursorKeys = [
    { at: 0, ...home, opacity: 0 },
    { at: 0.8, ...home, opacity: 0 },
    { at: 1.45, x: widths[0] - 25, y: compact ? 53 : 51, opacity: 1 },
    { at: 1.82, x: widths[0] - 25, y: compact ? 53 : 51, opacity: 1 },
    { at: 2.4, x: margin + tabWidth * 0.5 + 10, y: tabsY + 8, opacity: 1 },
    { at: 2.88, x: margin + tabWidth * 1.5 + 10, y: tabsY + 8, opacity: 1 },
    { at: 3.58, x: margin + tabWidth * 2.5 + 10, y: tabsY + 8, opacity: 1 },
    { at: 4.28, x: margin + tabWidth * 3.5 + 10, y: tabsY + 8, opacity: 1 },
    { at: 5.42, x: maxWidth - 36, y: rowFirst + rowGap, opacity: 1 },
    { at: 7.65, x: maxWidth - 36, y: rowFirst + rowGap * 3, opacity: 1 },
    { at: 8.55, x: nodeX + 8, y: cardY + 23, opacity: 1 },
    { at: 9.4, x: nodeX + 12, y: keepY + 8, opacity: 1 },
    { at: 9.9, x: widths[3] - 31, y: keepY + 4, opacity: 1 },
    { at: 11.45, x: widths[4] - 31, y: compact ? 99 : 153, opacity: 1 },
    { at: 12.5, x: widths[4] - 31, y: compact ? 99 : 153, opacity: 1 },
    { at: 13.6, ...home, opacity: 0 },
    { at: 15, ...home, opacity: 0 },
  ];
  const index = Math.max(
    0,
    cursorKeys.findIndex(
      (key, i) =>
        i < cursorKeys.length - 1 &&
        time >= key.at &&
        time <= cursorKeys[i + 1].at,
    ),
  );
  const first = cursorKeys[index];
  const second = cursorKeys[index + 1];
  const amount = ease(first.at, second.at, time);
  const cursor = {
    x: mix(first.x, second.x, amount),
    y: mix(first.y, second.y, amount),
    opacity: mix(first.opacity, second.opacity, amount),
    scale: 1,
    ring: 0,
    ringOpacity: 0,
  };
  if (time >= 8.58 && time <= 9.4) {
    cursor.x = nodes[3].x + 8;
    cursor.y = nodes[3].y + 8;
  }
  for (const click of [1.65, 2.95, 3.65, 4.35, 7.83, 8.69, 9.93, 12.08]) {
    const since = time - click;
    if (since >= 0 && since <= 0.32) {
      cursor.scale = 1 - Math.sin(clamp(since / 0.18) * Math.PI) * 0.1;
      cursor.ring = 3 + 12 * ease(0, 0.32, since);
      cursor.ringOpacity = (1 - ease(0.02, 0.32, since)) * 0.55;
    }
  }

  return {
    time,
    state: time >= 13.5 ? 'reset' : current.id,
    phase: cueIndex,
    compact,
    width,
    height,
    shape,
    panels,
    nodes,
    tabs: { left, right },
    rows: [0, 1, 2, 3].map((i) => ease(5.36 + i * 0.13, 5.88 + i * 0.13, time)),
    drag,
    kept,
    branches,
    brief: ease(12.1, 12.38, time),
    cursor,
  };
}
