import { Group } from 'three';
import type { IconModelKit } from './icon-model-kit';

const arrow = [
  [-0.25, -0.72],
  [0.25, -0.72],
  [0.25, 0.1],
  [0.7, 0.1],
  [0, 0.85],
  [-0.7, 0.1],
  [-0.25, 0.1],
] as const;

export function buildUtilityIcon(name: string, kit: IconModelKit): Group {
  const g = new Group();
  const extrudedArrow = () => kit.extrude(arrow, 0.4);
  switch (name) {
    case 'send': {
      const left = kit.extrude(
        [
          [-1, -0.3],
          [1, 0.8],
          [-0.08, -1],
          [-0.25, -0.12],
        ],
        0.3,
      );
      const ridge = kit.rod([-0.25, -0.12, 0.2], [1, 0.8, 0.2], 0.07, 'ink');
      g.add(left, ridge);
      break;
    }
    case 'add':
    case 'close': {
      g.add(kit.box(0.4, 2, 0.45), kit.box(2, 0.4, 0.45));
      if (name === 'close') g.rotation.z = Math.PI / 4;
      break;
    }
    case 'forward':
    case 'open': {
      const a = extrudedArrow();
      a.rotation.z = -Math.PI / 2;
      if (name === 'open') a.rotation.z = -Math.PI / 4;
      g.add(a);
      break;
    }
    case 'download':
    case 'upload': {
      const a = extrudedArrow();
      a.scale.setScalar(0.82);
      a.position.y = 0.25;
      if (name === 'download') a.rotation.z = Math.PI;
      g.add(
        a,
        kit.box(1.8, 0.24, 0.85, 0, -0.83),
        kit.box(0.2, 0.5, 0.85, -0.8, -0.65),
        kit.box(0.2, 0.5, 0.85, 0.8, -0.65),
      );
      break;
    }
    case 'pin': {
      g.add(
        kit.cylinder(0.55, 0.55, 0.25, 0, 0.62),
        kit.cylinder(0.2, 0.37, 0.85, 0, 0.08),
        kit.cylinder(0.38, 0.38, 0.18, 0, -0.32),
        kit.cylinder(0.09, 0, 0.78, 0, -0.75),
      );
      g.rotation.z = -0.25;
      break;
    }
    case 'remove': {
      g.add(
        kit.cylinder(0.67, 0.5, 1.35, 0, -0.14),
        kit.cylinder(0.75, 0.75, 0.2, 0, 0.62),
        kit.box(0.65, 0.22, 0.32, 0, 0.84),
      );
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        const rib = kit.box(
          0.075,
          0.86,
          0.06,
          Math.sin(a) * 0.575,
          -0.18,
          Math.cos(a) * 0.575,
          'ink',
        );
        rib.rotation.y = a;
        g.add(rib);
      }
      break;
    }
    case 'search': {
      const ring = kit.torus(0.64, 0.17, -0.28, 0.28, 0);
      g.add(ring, kit.rod([0.23, -0.23, 0], [0.9, -0.95, 0], 0.2));
      break;
    }
    case 'select':
    case 'select-empty': {
      g.add(kit.box(2, 2, 0.4, 0, 0, 0, 'ink'), kit.box(1.7, 1.7, 0.43));
      if (name === 'select') {
        const check = kit.extrude(
          [
            [-1, 0.05],
            [-0.68, 0.34],
            [-0.2, -0.16],
            [0.74, 0.83],
            [1, 0.55],
            [-0.2, -0.77],
          ],
          0.22,
          'ink',
        );
        check.scale.setScalar(0.65);
        check.position.z = 0.32;
        g.add(check);
      }
      break;
    }
    case 'settings': {
      const ring = kit.torus(0.62, 0.3);
      g.add(ring);
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const tooth = kit.box(
          0.4,
          0.5,
          0.48,
          Math.sin(a) * 0.83,
          Math.cos(a) * 0.83,
        );
        tooth.rotation.z = -a;
        g.add(tooth);
      }
      break;
    }
    case 'help': {
      g.add(
        kit.rod([-0.5, 0.44, 0], [-0.42, 0.76, 0], 0.17),
        kit.rod([-0.42, 0.76, 0], [0.35, 0.76, 0], 0.17),
        kit.rod([0.35, 0.76, 0], [0.5, 0.4, 0], 0.17),
        kit.rod([0.5, 0.4, 0], [0, -0.1, 0], 0.17),
        kit.rod([0, -0.1, 0], [0, -0.35, 0], 0.17),
        kit.sphere(0.2, 0, -0.85, 0),
      );
      break;
    }
    case 'fit': {
      for (const x of [-1, 1])
        for (const y of [-1, 1])
          g.add(
            kit.box(0.65, 0.24, 0.4, x * 0.65, y * 0.85),
            kit.box(0.24, 0.65, 0.4, x * 0.85, y * 0.65),
          );
      break;
    }
    default:
      g.add(kit.sphere(0.85));
  }
  return g;
}
