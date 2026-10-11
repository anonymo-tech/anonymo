import type { Group } from 'three';
import type { IconModelKit } from './icon-model-kit';

type Tone = 'ivory' | 'ink';

function library(kit: IconModelKit): Group {
  const book = (width: number, height: number, depth: number, tone: Tone) => {
    const volume = kit.group(
      kit.box(width - 0.1, height - 0.1, depth - 0.1, 0, 0, 0, 'ivory', 0.025),
      kit.box(width, 0.07, depth, 0, height / 2, 0, tone, 0.025),
      kit.box(width, 0.07, depth, 0, -height / 2, 0, tone, 0.025),
      kit.box(width, height, 0.1, 0, 0, depth / 2 - 0.045, tone, 0.04),
    );
    for (const x of [-width * 0.34, width * 0.34]) {
      volume.add(kit.box(0.05, height - 0.025, 0.035, x, 0, depth / 2 + 0.012, 'ivory', 0.012));
    }
    for (const y of [-height * 0.2, height * 0.2]) {
      volume.add(kit.box(width - 0.18, 0.012, 0.025, 0, y, -depth / 2 + 0.04, 'ink', 0.003));
    }
    return volume;
  };
  const lower = book(1.87, 0.4, 0.96, 'ink');
  lower.position.set(-0.03, -0.57, 0);
  lower.rotation.y = -0.12;
  const middle = book(1.72, 0.4, 0.88, 'ivory');
  middle.position.set(0.07, -0.1, 0.04);
  middle.rotation.y = 0.12;
  const upper = book(1.63, 0.43, 0.9, 'ink');
  upper.position.set(-0.06, 0.385, -0.015);
  upper.rotation.y = -0.16;
  return kit.group(lower, middle, upper);
}

function decisions(kit: IconModelKit): Group {
  const scales = kit.group(
    kit.cylinder(0.48, 0.61, 0.15, 0, -0.91, 0, 'ink'),
    kit.cylinder(0.31, 0.4, 0.1, 0, -0.79, 0, 'ivory'),
    kit.cylinder(0.07, 0.095, 1.45, 0, -0.04, -0.035, 'ivory'),
    kit.sphere(0.13, 0, 0.77, -0.035, 'ink'),
    kit.rod([-0.84, 0.63, 0], [0.84, 0.63, 0], 0.06, 'ivory'),
    kit.sphere(0.075, -0.84, 0.63, 0, 'ink'),
    kit.sphere(0.075, 0.84, 0.63, 0, 'ink'),
  );
  for (const x of [-0.8, 0.8]) {
    const rim = kit.torus(0.257, 0.038, x, -0.245, 0, 'ivory');
    rim.rotation.x = Math.PI / 2;
    scales.add(
      kit.cylinder(0.28, 0.13, 0.13, x, -0.32, 0, 'ivory'),
      kit.cylinder(0.22, 0.22, 0.015, x, -0.247, 0, 'ink'),
      rim,
      kit.rod([x, 0.63, 0], [x - 0.235, -0.24, 0.105], 0.018, 'ink'),
      kit.rod([x, 0.63, 0], [x + 0.235, -0.24, 0.105], 0.018, 'ink'),
      kit.rod([x, 0.63, 0], [x, -0.24, -0.25], 0.018, 'ink'),
    );
  }
  return scales;
}

function connections(kit: IconModelKit): Group {
  const upper = kit.torus(0.48, 0.16, -0.36, 0.3, 0, 'ivory');
  upper.rotation.set(-0.48, 0.35, -0.48);
  upper.scale.y = 1.25;
  const lower = kit.torus(0.48, 0.16, 0.36, -0.3, 0.03, 'ink');
  lower.rotation.set(0.78, -0.58, -0.48);
  lower.scale.y = 1.25;
  const chain = kit.group(upper, lower);
  chain.scale.setScalar(0.86);
  return chain;
}

function purse(kit: IconModelKit): Group {
  const coin = (radius: number, tone: Tone, visibleFaces = false) => {
    const upperRim = kit.torus(radius - 0.035, 0.022, 0, 0.075, 0, 'ivory');
    const lowerRim = kit.torus(radius - 0.035, 0.022, 0, -0.075, 0, 'ivory');
    upperRim.rotation.x = Math.PI / 2;
    lowerRim.rotation.x = Math.PI / 2;
    const result = kit.group(
      kit.cylinder(radius, radius, 0.145, 0, 0, 0, tone),
      upperRim,
      lowerRim,
    );
    if (visibleFaces) {
      const faceRing = kit.torus(radius * 0.56, 0.018, 0, 0.082, 0, tone === 'ink' ? 'ivory' : 'ink');
      faceRing.rotation.x = Math.PI / 2;
      const reverseRing = faceRing.clone();
      reverseRing.position.y = -0.082;
      result.add(faceRing, reverseRing);
    }
    return result;
  };
  const pieces: Group[] = [];
  for (let i = 0; i < 6; i += 1) {
    const piece = coin(0.48, i % 2 === 0 ? 'ivory' : 'ink', i === 5);
    piece.position.set(-0.31 + (i % 2) * 0.025, -0.72 + i * 0.166, -0.1);
    pieces.push(piece);
  }
  for (let i = 0; i < 3; i += 1) {
    const piece = coin(0.4, 'ivory', i === 2);
    piece.position.set(0.48, -0.72 + i * 0.166, -0.04);
    pieces.push(piece);
  }
  const leaning = coin(0.44, 'ivory', true);
  leaning.position.set(0.22, -0.34, 0.55);
  leaning.rotation.set(1.24, 0, -0.2);
  const pile = kit.group(...pieces, leaning);
  pile.position.y = 0.22;
  return pile;
}

function chapters(kit: IconModelKit): Group {
  const bust = (tone: Tone) => {
    const shoulders = kit.sphere(1, 0, -0.12, 0, tone);
    shoulders.scale.set(0.4, 0.34, 0.25);
    const head = kit.sphere(0.24, 0, 0.44, 0, tone);
    head.scale.set(0.9, 1.14, 0.93);
    return kit.group(
      kit.box(0.69, 0.14, 0.56, 0, -0.47, 0, 'ink', 0.04),
      kit.box(0.54, 0.12, 0.45, 0, -0.36, 0, 'ivory', 0.04),
      shoulders,
      kit.cylinder(0.115, 0.145, 0.24, 0, 0.18, 0, tone),
      head,
    );
  };
  const left = bust('ivory');
  left.scale.setScalar(0.79);
  left.position.set(-0.68, -0.15, -0.2);
  left.rotation.y = -0.18;
  const right = bust('ivory');
  right.scale.setScalar(0.79);
  right.position.set(0.68, -0.15, -0.2);
  right.rotation.y = 0.18;
  const center = bust('ivory');
  center.position.set(0, 0.05, 0.18);
  return kit.group(left, right, center);
}

function brief(kit: IconModelKit): Group {
  const scroll = kit.group(kit.box(1.17, 1.37, 0.12, 0, 0, 0, 'ivory', 0.03));
  for (const y of [-0.66, 0.66]) {
    const roll = kit.cylinder(0.19, 0.19, 1.4, 0, y, 0.035, 'ivory');
    roll.rotation.z = Math.PI / 2;
    scroll.add(roll);
    for (const x of [-0.706, 0.706]) {
      const core = kit.cylinder(0.123, 0.123, 0.018, x, y, 0.035, 'ink');
      core.rotation.z = Math.PI / 2;
      const spiral = kit.torus(0.118, 0.025, x * 1.012, y, 0.035, 'ivory');
      spiral.rotation.y = Math.PI / 2;
      scroll.add(core, spiral);
    }
  }
  for (const [y, width] of [[0.27, 0.73], [0.06, 0.73], [-0.15, 0.47]]) {
    scroll.add(kit.box(width, 0.032, 0.026, (width - 0.73) / 2, y, 0.07, 'ink', 0.012));
  }
  return scroll;
}

function copy(kit: IconModelKit): Group {
  const sheet = (tone: Tone) => {
    const body = kit.extrude([[-0.64, -0.79], [0.64, -0.79], [0.64, 0.47], [0.34, 0.79], [-0.64, 0.79]], 0.15, tone);
    const fold = kit.extrude([[0.34, 0.79], [0.34, 0.47], [0.64, 0.47]], 0.085, tone === 'ivory' ? 'ink' : 'ivory');
    fold.position.z = 0.095;
    return kit.group(body, fold);
  };
  const behind = sheet('ink');
  behind.position.set(-0.18, 0.16, -0.16);
  behind.rotation.z = 0.09;
  const front = sheet('ivory');
  front.position.set(0.15, -0.14, 0.13);
  front.rotation.z = -0.065;
  for (const y of [0.17, -0.05, -0.27]) {
    front.add(kit.box(0.71, 0.033, 0.027, -0.08, y, 0.083, 'ink', 0.012));
  }
  return kit.group(behind, front);
}

function branch(kit: IconModelKit): Group {
  const origin: [number, number, number] = [0, -0.67, 0.03];
  const fork: [number, number, number] = [0, -0.05, 0];
  const left: [number, number, number] = [-0.67, 0.6, 0.02];
  const right: [number, number, number] = [0.67, 0.6, -0.1];
  return kit.group(
    kit.rod(origin, fork, 0.1, 'ink'),
    kit.rod(fork, left, 0.1, 'ink'),
    kit.rod(fork, right, 0.1, 'ink'),
    kit.sphere(0.12, ...fork, 'ink'),
    kit.sphere(0.26, ...origin, 'ivory'),
    kit.sphere(0.26, ...left, 'ivory'),
    kit.sphere(0.26, ...right, 'ivory'),
  );
}

function route(kit: IconModelKit): Group {
  const shell = kit.cylinder(0.87, 0.87, 0.28, 0, 0, 0, 'ink');
  shell.rotation.x = Math.PI / 2;
  const dial = kit.cylinder(0.76, 0.76, 0.07, 0, 0, 0.162, 'ivory');
  dial.rotation.x = Math.PI / 2;
  const compass = kit.group(
    shell,
    dial,
    kit.torus(0.8, 0.067, 0, 0, 0.195, 'ivory'),
    kit.torus(0.8, 0.05, 0, 0, -0.145, 'ivory'),
    kit.torus(0.107, 0.036, 0, 1, 0, 'ivory'),
    kit.box(0.2, 0.13, 0.19, 0, 0.877, 0, 'ink', 0.04),
  );
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    const marker = kit.box(0.042, i % 2 === 0 ? 0.15 : 0.085, 0.035, Math.sin(angle) * 0.635, Math.cos(angle) * 0.635, 0.215, 'ink', 0.009);
    marker.rotation.z = -angle;
    compass.add(marker);
  }
  const north = kit.extrude([[0, 0.59], [-0.18, 0], [0.18, 0]], 0.13, 'ink');
  const south = kit.extrude([[0, -0.59], [0.18, 0], [-0.18, 0]], 0.13, 'ivory');
  const needle = kit.group(north, south);
  needle.rotation.z = -0.43;
  needle.position.z = 0.32;
  compass.add(needle, kit.sphere(0.093, 0, 0, 0.42, 'ink'));
  const reverseMedallion = kit.cylinder(0.3, 0.3, 0.035, 0, 0, -0.158, 'ivory');
  reverseMedallion.rotation.x = Math.PI / 2;
  compass.add(reverseMedallion);
  return compass;
}

export function buildSecondaryIcon(name: string, kit: IconModelKit): Group | null {
  switch (name) {
    case 'library': return library(kit);
    case 'decisions': return decisions(kit);
    case 'connections': return connections(kit);
    case 'purse': return purse(kit);
    case 'chapters': return chapters(kit);
    case 'brief': return brief(kit);
    case 'copy': return copy(kit);
    case 'branch': return branch(kit);
    case 'route': return route(kit);
    default: return null;
  }
}
