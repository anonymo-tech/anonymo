import assert from 'node:assert/strict';
import { arrangeCanvas } from '../lib/canvas-arrange.ts';
const turns = [{ id: 'p1', answers: [{ id: 'a1' }, { id: 'a2' }] }, { id: 'p2', answers: [{ id: 'a3' }] }];
const nodes = [
  ['p1', 340, 310], ['a1', 450, 800], ['a2', 450, 350], ['p2', 340, 120], ['a3', 470, 1600],
].map(([id, width, height]) => ({ id, measured: { width, height }, position: { x: -999, y: -999 }, data: { text: 'kept' } }));
const arranged = arrangeCanvas(nodes, turns);
assert.ok(arranged);
for (const [i, a] of arranged.entries()) for (const b of arranged.slice(i + 1)) {
  assert.ok(a.position.x + a.measured.width <= b.position.x || b.position.x + b.measured.width <= a.position.x || a.position.y + a.measured.height <= b.position.y || b.position.y + b.measured.height <= a.position.y, `${a.id} overlaps ${b.id}`);
}
assert.equal(arranged[3].position.y, 310 + 80 + 800 + 120);
assert.deepEqual(arranged.map(n => n.data), nodes.map(n => n.data));
assert.equal(nodes[0].position.x, -999);
assert.equal(arrangeCanvas(nodes.map(n => n.id === 'a1' ? { ...n, measured: undefined } : n), turns), null);
assert.equal(arrangeCanvas(nodes.map(n => n.id === 'a1' ? { ...n, measured: { width: 100, height: Infinity } } : n), turns), null);
console.log('Tidy canvas: non-overlap across tall measured cards, missing-measurement rejection and immutable content checks passed.');
