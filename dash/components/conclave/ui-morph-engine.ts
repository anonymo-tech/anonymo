/** A seekable 120 BPM / 28 beat sequence. No accumulated frame state. */
export const UI_MORPH_DURATION = 14;
export const UI_MORPH_FEATURE_CYCLE = 7;
export type UiMorphKind = 'council' | 'boundary' | 'purse';
export type UiMorphState =
  | 'prompt'
  | 'loading'
  | 'tabs'
  | 'compare'
  | 'vote'
  | 'brief'
  | 'route'
  | 'privacy'
  | 'guard'
  | 'chart'
  | 'tooltip'
  | 'receipt';

type Shape = { width: number; height: number; radius: number };
type Cue = Shape & { at: number; id: UiMorphState };
type CursorKey = { at: number; x: number; y: number; opacity: number };
export type UiMorphPanel = {
  id: UiMorphState;
  opacity: number;
  blur: number;
  y: number;
};
export type UiMorphFrame = {
  time: number;
  state: UiMorphState;
  shape: Shape & { x: number; y: number };
  panels: UiMorphPanel[];
  cursor: {
    x: number;
    y: number;
    opacity: number;
    scale: number;
    ring: number;
    ringOpacity: number;
  };
  details: {
    spinner: number;
    toggle: number;
    toggleEdges: { left: number; right: number };
    tabEdges: { left: number; right: number };
    redaction: number;
    vote: number;
    routeFocus: number;
    chartFocus: { x: number; opacity: number };
    receiptMark: number;
    bars: number[];
  };
};

// The final cue is also the initial state across the seamless loop boundary.
export const UI_MORPH_CUES: Record<UiMorphKind, readonly Cue[]> = {
  council: [
    { at: 0.75, id: 'loading', width: 62, height: 62, radius: 31 },
    { at: 1.5, id: 'tabs', width: 306, height: 144, radius: 16 },
    { at: 2.5, id: 'compare', width: 322, height: 176, radius: 16 },
    { at: 3.5, id: 'vote', width: 304, height: 158, radius: 16 },
    { at: 4.5, id: 'brief', width: 260, height: 198, radius: 14 },
    { at: 6, id: 'prompt', width: 310, height: 62, radius: 18 },
  ],
  boundary: [
    { at: 1.5, id: 'privacy', width: 288, height: 132, radius: 18 },
    { at: 3, id: 'guard', width: 292, height: 172, radius: 16 },
    { at: 4.5, id: 'route', width: 290, height: 184, radius: 16 },
  ],
  purse: [
    { at: 1.5, id: 'tooltip', width: 310, height: 194, radius: 16 },
    { at: 3, id: 'receipt', width: 268, height: 198, radius: 14 },
    { at: 4.5, id: 'chart', width: 300, height: 184, radius: 16 },
  ],
};

export const UI_MORPH_STATIC_TIME: Record<UiMorphKind, number> = {
  council: 3,
  boundary: 5,
  purse: 5,
};

const CURSORS: Record<UiMorphKind, readonly CursorKey[]> = {
  council: [
    { at: 0, x: 311, y: 159, opacity: 0 },
    { at: 0.3, x: 298, y: 117, opacity: 1 },
    { at: 0.63, x: 298, y: 117, opacity: 1 },
    { at: 0.83, x: 298, y: 117, opacity: 0 },
    { at: 1.65, x: 304, y: 164, opacity: 0 },
    { at: 1.96, x: 264, y: 106, opacity: 1 },
    { at: 2.33, x: 264, y: 106, opacity: 1 },
    { at: 2.65, x: 280, y: 155, opacity: 0 },
    { at: 3.62, x: 307, y: 171, opacity: 0 },
    { at: 3.9, x: 285, y: 146, opacity: 1 },
    { at: 4.3, x: 285, y: 146, opacity: 1 },
    { at: 4.6, x: 285, y: 146, opacity: 0 },
    { at: 5.06, x: 301, y: 207, opacity: 0 },
    { at: 5.34, x: 270, y: 192, opacity: 1 },
    { at: 5.64, x: 270, y: 192, opacity: 1 },
    { at: 6.05, x: 311, y: 159, opacity: 0 },
    { at: 7, x: 311, y: 159, opacity: 0 },
  ],
  boundary: [
    { at: 0, x: 316, y: 158, opacity: 0 },
    { at: 0.4, x: 280, y: 177, opacity: 1 },
    { at: 0.95, x: 280, y: 177, opacity: 1 },
    { at: 1.25, x: 310, y: 143, opacity: 0 },
    { at: 1.7, x: 310, y: 143, opacity: 0 },
    { at: 2, x: 259, y: 117, opacity: 1 },
    { at: 2.12, x: 259, y: 117, opacity: 1 },
    { at: 2.4, x: 283, y: 117, opacity: 1 },
    { at: 2.75, x: 294, y: 145, opacity: 0 },
    { at: 3.35, x: 318, y: 179, opacity: 0 },
    { at: 3.68, x: 274, y: 169, opacity: 1 },
    { at: 4.15, x: 274, y: 169, opacity: 1 },
    { at: 4.5, x: 315, y: 128, opacity: 0 },
    { at: 4.95, x: 286, y: 93, opacity: 1 },
    { at: 5.45, x: 286, y: 93, opacity: 1 },
    { at: 5.85, x: 280, y: 177, opacity: 1 },
    { at: 6.25, x: 280, y: 177, opacity: 1 },
    { at: 6.65, x: 316, y: 158, opacity: 0 },
    { at: 7, x: 316, y: 158, opacity: 0 },
  ],
  purse: [
    { at: 0, x: 319, y: 196, opacity: 0 },
    { at: 0.4, x: 59, y: 158, opacity: 1 },
    { at: 1.18, x: 199, y: 139, opacity: 1 },
    { at: 1.85, x: 199, y: 139, opacity: 1 },
    { at: 2.55, x: 287, y: 48, opacity: 1 },
    { at: 2.86, x: 287, y: 48, opacity: 1 },
    { at: 3.2, x: 303, y: 66, opacity: 0 },
    { at: 3.5, x: 280, y: 157, opacity: 0 },
    { at: 3.85, x: 280, y: 157, opacity: 1 },
    { at: 4.15, x: 280, y: 157, opacity: 1 },
    { at: 4.45, x: 309, y: 179, opacity: 0 },
    { at: 4.85, x: 59, y: 157, opacity: 1 },
    { at: 6.3, x: 269, y: 122, opacity: 1 },
    { at: 6.7, x: 319, y: 196, opacity: 0 },
    { at: 7, x: 319, y: 196, opacity: 0 },
  ],
};
const CLICKS: Record<UiMorphKind, number[]> = {
  council: [0.52, 2.02, 4.02, 5.44],
  boundary: [0.78, 2.11, 3.91, 6.05],
  purse: [2.72, 4.01, 4.95],
};

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;

export function morphEase(start: number, end: number, time: number): number {
  const x = clamp((time - start) / (end - start));
  return x * x * (3 - 2 * x);
}

export function wrapMorphTime(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return (
    ((seconds % UI_MORPH_DURATION) + UI_MORPH_DURATION) % UI_MORPH_DURATION
  );
}

const cycleTime = (seconds: number) =>
  ((seconds % UI_MORPH_FEATURE_CYCLE) + UI_MORPH_FEATURE_CYCLE) %
  UI_MORPH_FEATURE_CYCLE;

/** Closed-form damped step response, with < 0.1% overshoot. */
export function morphSpringStep(seconds: number): number {
  if (seconds <= 0) return 0;
  const frequency = 24;
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

function shapeAt(kind: UiMorphKind, time: number): UiMorphFrame['shape'] {
  const cues = UI_MORPH_CUES[kind];
  const base = cues[cues.length - 1];
  const result: Shape = {
    width: base.width,
    height: base.height,
    radius: base.radius,
  };
  // Sum target-change responses, including the prior two loops. This makes
  // seeking independent of frame rate and carries residual motion over a wrap.
  for (const cycle of [-2, -1, 0]) {
    for (let index = 0; index < cues.length; index++) {
      const current = cues[index];
      const previous = cues[(index + cues.length - 1) % cues.length];
      const response = morphSpringStep(
        time - current.at - cycle * UI_MORPH_FEATURE_CYCLE,
      );
      result.width += (current.width - previous.width) * response;
      result.height += (current.height - previous.height) * response;
      result.radius += (current.radius - previous.radius) * response;
    }
  }
  return {
    ...result,
    x: (350 - result.width) / 2,
    y: (235 - result.height) / 2,
  };
}

function cursorAt(kind: UiMorphKind, time: number): UiMorphFrame['cursor'] {
  const keys = CURSORS[kind];
  let first = keys[0];
  let second = keys[keys.length - 1];
  for (let index = 0; index < keys.length - 1; index++) {
    if (time >= keys[index].at && time <= keys[index + 1].at) {
      first = keys[index];
      second = keys[index + 1];
      break;
    }
  }
  const amount = morphEase(first.at, second.at, time);
  let press = 0;
  let ring = 0;
  let ringOpacity = 0;
  for (const click of CLICKS[kind]) {
    const since = time - click;
    if (since >= 0 && since < 0.32) {
      press = Math.sin(Math.PI * clamp(since / 0.18));
      ring = 4 + 13 * morphEase(0, 0.32, since);
      ringOpacity = (1 - morphEase(0.05, 0.32, since)) * 0.5;
    }
  }
  return {
    x: mix(first.x, second.x, amount),
    y: mix(first.y, second.y, amount),
    opacity: mix(first.opacity, second.opacity, amount),
    scale: 1 - press * 0.08,
    ring,
    ringOpacity,
  };
}

/** Evaluate every animated property at an arbitrary absolute second. */
export function seekUiMorph(kind: UiMorphKind, seconds: number): UiMorphFrame {
  const time = cycleTime(wrapMorphTime(seconds));
  const cues = UI_MORPH_CUES[kind];
  let state = cues[cues.length - 1].id;
  for (const cue of cues) if (time >= cue.at) state = cue.id;
  const panels = cues.map((cue, index) => {
    const next = cues[(index + 1) % cues.length];
    const duration = cycleTime(next.at - cue.at);
    const elapsed = cycleTime(time - cue.at);
    const enter = morphEase(0.055, 0.24, elapsed);
    const leave = morphEase(duration - 0.13, duration, elapsed);
    const opacity = elapsed < duration ? enter * (1 - leave) : 0;
    return {
      id: cue.id,
      opacity,
      blur: (1 - opacity) * 2.5,
      y: (1 - enter) * 5 - leave * 3,
    };
  });
  const cursor = cursorAt(kind, time);
  const reset = 1 - morphEase(6.3, 6.8, time);
  const chartDrag =
    morphEase(0.15, 0.4, time) * (1 - morphEase(1.35, 1.5, time)) +
    morphEase(4.65, 4.85, time) * (1 - morphEase(6.3, 6.65, time));
  return {
    time,
    state,
    shape: shapeAt(kind, time),
    panels,
    cursor,
    details: {
      spinner: time >= 0.75 && time <= 1.5 ? (time - 0.75) * 720 : 0,
      toggle: morphEase(2.11, 2.38, time) * reset,
      toggleEdges: {
        left: 250 + 22 * morphSpringStep(time - 2.17) * reset,
        right: 270 + 22 * morphSpringStep(time - 2.11) * reset,
      },
      tabEdges: {
        left: 43 + 174 * morphSpringStep(time - 2.1) * reset,
        right: 127 + 180 * morphSpringStep(time - 2.02) * reset,
      },
      redaction: morphEase(3.85, 4.15, time) * reset,
      vote: morphEase(4.02, 4.22, time) * reset,
      routeFocus:
        morphEase(4.85, 5.05, time) * (1 - morphEase(5.5, 5.75, time)),
      chartFocus: {
        x: Math.max(44, Math.min(254, cursor.x - 15)),
        opacity: chartDrag * 0.07,
      },
      receiptMark: morphEase(3.3, 3.65, time) * reset,
      bars: [22, 39, 26, 50, 44, 32, 64],
    },
  };
}
