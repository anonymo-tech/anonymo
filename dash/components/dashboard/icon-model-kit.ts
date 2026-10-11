import {
  BoxGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type IconTone = 'ivory' | 'ink';
type Point3 = [number, number, number];

export function createIconModelKit(materials: Record<IconTone, Material>) {
  const kit = {
    box(
      w: number,
      h: number,
      d: number,
      x = 0,
      y = 0,
      z = 0,
      tone: IconTone = 'ivory',
      bevel = 0.08,
    ) {
      const radius = Math.min(bevel, Math.min(w, h, d) * 0.4);
      const mesh = new Mesh(
        radius > 0
          ? new RoundedBoxGeometry(w, h, d, 2, radius)
          : new BoxGeometry(w, h, d),
        materials[tone],
      );
      mesh.position.set(x, y, z);
      return mesh;
    },
    sphere(radius: number, x = 0, y = 0, z = 0, tone: IconTone = 'ivory') {
      const mesh = new Mesh(
        new SphereGeometry(radius, 24, 16),
        materials[tone],
      );
      mesh.position.set(x, y, z);
      return mesh;
    },
    cylinder(
      top: number,
      bottom: number,
      height: number,
      x = 0,
      y = 0,
      z = 0,
      tone: IconTone = 'ivory',
    ) {
      const mesh = new Mesh(
        new CylinderGeometry(top, bottom, height, 28),
        materials[tone],
      );
      mesh.position.set(x, y, z);
      return mesh;
    },
    torus(
      radius: number,
      tube: number,
      x = 0,
      y = 0,
      z = 0,
      tone: IconTone = 'ivory',
    ) {
      const mesh = new Mesh(
        new TorusGeometry(radius, tube, 12, 32),
        materials[tone],
      );
      mesh.position.set(x, y, z);
      return mesh;
    },
    extrude(
      points: readonly (readonly [number, number])[],
      depth: number,
      tone: IconTone = 'ivory',
    ) {
      const shape = new Shape();
      points.forEach(([x, y], i) =>
        i ? shape.lineTo(x, y) : shape.moveTo(x, y),
      );
      shape.closePath();
      const bevel = Math.min(0.055, depth * 0.2);
      const geometry = new ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: bevel,
        bevelThickness: bevel,
      });
      geometry.translate(0, 0, -depth / 2);
      return new Mesh(geometry, materials[tone]);
    },
    rod(start: Point3, end: Point3, radius: number, tone: IconTone = 'ivory') {
      const a = new Vector3(...start);
      const b = new Vector3(...end);
      const delta = b.clone().sub(a);
      const mesh = kit.cylinder(radius, radius, delta.length(), 0, 0, 0, tone);
      mesh.position.copy(a.add(b).multiplyScalar(0.5));
      mesh.quaternion.setFromUnitVectors(
        new Vector3(0, 1, 0),
        delta.normalize(),
      );
      return mesh;
    },
    group(...objects: Object3D[]) {
      const group = new Group();
      if (objects.length) group.add(...objects);
      return group;
    },
  };
  return kit;
}

export type IconModelKit = ReturnType<typeof createIconModelKit>;
