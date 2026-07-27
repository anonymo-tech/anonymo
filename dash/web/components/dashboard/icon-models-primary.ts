import { Group } from 'three';
import type { IconModelKit } from './icon-model-kit';

type Point = [number, number];

function folder(kit: IconModelKit): Group {
  const back = kit.extrude(
    [
      [-1, -0.88],
      [1, -0.88],
      [1, 0.62],
      [0.22, 0.62],
      [0.12, 0.92],
      [-0.62, 0.92],
      [-0.74, 0.62],
      [-1, 0.62],
    ],
    0.2,
  );
  back.position.z = -0.34;
  const papers = new Group();
  for (let i = 0; i < 3; i += 1) {
    const sheet = kit.box(
      1.73,
      1.35,
      0.085,
      0,
      -0.045 + i * 0.065,
      -0.16 + i * 0.105,
      'ivory',
      0.025,
    );
    sheet.rotation.z = (i - 1) * 0.018;
    papers.add(sheet);
  }
  const cover = kit.group(
    kit.box(2.04, 1.3, 0.2, 0, 0, 0, 'ivory', 0.095),
    kit.box(1.86, 0.035, 0.025, 0, 0.54, 0.105, 'ink', 0.01),
  );
  cover.position.set(0, -0.27, 0.31);
  cover.rotation.x = 0.12;
  return kit.group(
    back,
    papers,
    cover,
    kit.box(1.87, 0.17, 0.67, 0, -0.86, -0.015, 'ink', 0.055),
    kit.box(1.75, 0.05, 0.035, 0, -0.63, -0.455, 'ink', 0.01),
    kit.box(0.52, 0.035, 0.035, -0.25, 0.75, -0.455, 'ink', 0.01),
  );
}

function speechBubble(kit: IconModelKit): Group {
  const outline: Point[] = [
    [-0.52, 0.5],
    [0.52, 0.5],
    [0.64, 0.45],
    [0.71, 0.33],
    [0.71, -0.25],
    [0.65, -0.37],
    [0.52, -0.42],
    [0.03, -0.42],
    [-0.43, -0.74],
    [-0.31, -0.42],
    [-0.52, -0.42],
    [-0.64, -0.36],
    [-0.71, -0.25],
    [-0.71, 0.33],
    [-0.64, 0.45],
  ];
  const rim = kit.extrude(outline, 0.5, 'ink');
  const body = kit.extrude(outline, 0.54, 'ivory');
  body.scale.set(0.97, 0.97, 1);
  return kit.group(rim, body);
}

function chat(kit: IconModelKit): Group {
  const rear = speechBubble(kit);
  rear.scale.setScalar(0.86);
  rear.position.set(0.48, 0.55, -0.25);
  rear.rotation.y = -0.1;
  const front = speechBubble(kit);
  front.position.set(-0.38, -0.25, 0.25);
  front.rotation.y = 0.08;
  return kit.group(rear, front);
}

function card(kit: IconModelKit, x: number, y: number, z: number): Group {
  const object = kit.group(
    kit.box(0.87, 0.78, 0.46, 0, 0, 0, 'ivory', 0.065),
    kit.box(0.65, 0.035, 0.025, 0, -0.26, -0.242, 'ink', 0.01),
    kit.sphere(0.038, -0.3, 0.27, 0.23, 'ink'),
    kit.sphere(0.038, 0.3, -0.27, 0.23, 'ink'),
  );
  object.position.set(x, y, z);
  return object;
}

function canvas(kit: IconModelKit): Group {
  return kit.group(
    kit.rod([-0.57, 0.48, -0.03], [0.62, 0.62, -0.09], 0.095, 'ink'),
    kit.rod([-0.57, 0.48, -0.03], [0.48, -0.65, 0.09], 0.095, 'ink'),
    card(kit, -0.57, 0.48, 0),
    card(kit, 0.62, 0.62, -0.06),
    card(kit, 0.48, -0.65, 0.12),
  );
}

function clapper(kit: IconModelKit): Group {
  const top = kit.group(kit.box(2.04, 0.34, 0.53, 0, 0, 0, 'ivory', 0.035));
  for (const x of [-0.72, -0.23, 0.26, 0.75]) {
    for (const z of [-0.28, 0.28]) {
      const stripe = kit.box(0.17, 0.29, 0.035, x, 0, z, 'ink', 0.008);
      stripe.rotation.z = -0.47;
      top.add(stripe);
    }
  }
  top.position.set(-0.03, 0.68, 0);
  top.rotation.z = 0.15;
  const hinge = kit.cylinder(0.11, 0.11, 0.66, -0.87, 0.38, 0, 'ink');
  hinge.rotation.x = Math.PI / 2;
  return kit.group(
    kit.box(2, 1.3, 0.55, 0, -0.32, 0, 'ink', 0.055),
    kit.box(1.7, 0.85, 0.075, 0, -0.42, 0.286, 'ivory', 0.025),
    kit.box(1.7, 0.85, 0.075, 0, -0.42, -0.286, 'ivory', 0.025),
    kit.box(1.73, 0.085, 0.61, 0, 0.2, 0, 'ivory', 0.02),
    kit.box(0.07, 0.68, 0.03, -0.4, -0.42, 0.335, 'ink', 0.008),
    kit.box(0.07, 0.68, 0.03, 0.4, -0.42, -0.335, 'ink', 0.008),
    top,
    hinge,
  );
}

function helmet(kit: IconModelKit): Group {
  const shell = kit.sphere(0.86, 0, -0.06, 0, 'ivory');
  shell.scale.set(1, 1.05, 0.85);
  const visor = kit.sphere(0.77, 0, 0.015, 0.37, 'ink');
  visor.scale.set(1, 0.29, 0.55);
  const jaw = kit.box(1.2, 0.49, 0.65, 0, -0.53, 0.16, 'ivory', 0.16);
  const nose = kit.extrude(
    [
      [-0.105, 0.39],
      [0.105, 0.39],
      [0.13, -0.39],
      [0, -0.64],
      [-0.13, -0.39],
    ],
    0.21,
    'ivory',
  );
  nose.position.z = 0.79;
  const cheeks = new Group();
  for (const side of [-1, 1]) {
    const guard = kit.extrude(
      [
        [side * 0.77, 0.06],
        [side * 0.39, -0.26],
        [side * 0.34, -0.73],
        [side * 0.63, -0.58],
      ],
      0.36,
      'ivory',
    );
    guard.position.z = 0.39;
    cheeks.add(guard, kit.sphere(0.065, side * 0.64, 0.08, 0.61, 'ink'));
    cheeks.add(kit.sphere(0.048, side * 0.49, 0.48, 0.52, 'ink'));
  }
  return kit.group(
    shell,
    visor,
    jaw,
    nose,
    cheeks,
    kit.box(0.14, 0.58, 0.67, 0, 0.78, -0.02, 'ink', 0.035),
    kit.box(0.19, 0.45, 0.59, 0, 0.82, -0.03, 'ivory', 0.035),
    kit.box(0.83, 0.055, 0.07, 0, -0.09, -0.73, 'ink', 0.02),
    kit.box(0.74, 0.055, 0.07, 0, -0.23, -0.705, 'ink', 0.02),
    kit.box(0.6, 0.055, 0.07, 0, -0.37, -0.66, 'ink', 0.02),
  );
}

function more(kit: IconModelKit): Group {
  const object = new Group();
  for (const x of [-0.76, 0, 0.76]) {
    const z = x === 0 ? 0.13 : -0.08;
    object.add(kit.sphere(0.32, x, 0, z, 'ivory'));
    const seam = kit.torus(0.319, 0.012, x, 0, z, 'ink');
    seam.rotation.y = 0.4;
    object.add(seam);
  }
  return object;
}

function uploadTray(kit: IconModelKit): Group {
  const arrow = kit.extrude(
    [
      [-0.18, -0.36],
      [0.18, -0.36],
      [0.18, 0.38],
      [0.62, 0.38],
      [0, 1.06],
      [-0.62, 0.38],
      [-0.18, 0.38],
    ],
    0.46,
    'ivory',
  );
  arrow.position.z = 0.055;
  return kit.group(
    arrow,
    kit.box(1.86, 0.19, 0.97, 0, -0.91, 0, 'ivory', 0.055),
    kit.box(1.86, 0.39, 0.16, 0, -0.66, -0.4, 'ivory', 0.045),
    kit.box(0.16, 0.43, 0.85, -0.85, -0.64, 0, 'ivory', 0.045),
    kit.box(0.16, 0.43, 0.85, 0.85, -0.64, 0, 'ivory', 0.045),
    kit.box(0.68, 0.28, 0.16, -0.56, -0.72, 0.4, 'ivory', 0.035),
    kit.box(0.68, 0.28, 0.16, 0.56, -0.72, 0.4, 'ivory', 0.035),
    kit.box(1.46, 0.025, 0.59, 0, -0.79, 0, 'ink', 0.01),
    kit.box(0.07, 0.52, 0.03, 0, 0.01, -0.195, 'ink', 0.01),
  );
}

export function buildPrimaryIcon(
  name: string,
  kit: IconModelKit,
): Group | null {
  switch (name) {
    case 'rooms':
      return folder(kit);
    case 'chat':
      return chat(kit);
    case 'canvas':
      return canvas(kit);
    case 'studio':
      return clapper(kit);
    case 'agents':
      return helmet(kit);
    case 'more':
      return more(kit);
    case 'attach':
      return uploadTray(kit);
    default:
      return null;
  }
}
