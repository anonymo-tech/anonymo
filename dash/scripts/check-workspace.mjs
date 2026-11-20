import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceStage } from '../lib/anonymo/workspace-guide.ts';

test('the overview suggests the next action based on confirmed credit and device receipts', () => {
  for (const hasReceipts of [true, false]) {
    for (const amount of [null, NaN, 0, 2])
      assert.equal(workspaceStage(false, amount, hasReceipts), 'key');
    for (const amount of [null, NaN, Infinity])
      assert.equal(workspaceStage(true, amount, hasReceipts), 'unknown');
    for (const amount of [-1, 0])
      assert.equal(workspaceStage(true, amount, hasReceipts), 'funds');
  }
  assert.equal(workspaceStage(true, 1, false), 'first-chat');
  assert.equal(workspaceStage(true, 1, true), 'returning');
});
