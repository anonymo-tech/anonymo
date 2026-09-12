import assert from 'node:assert/strict';
import test from 'node:test';
import { MODELS } from '../components/dashboard/data.ts';
import {
  canvasLimits,
  canvasPrompts,
  createBrief,
  createRoom,
  createSampleTurn,
  initialWorkspace,
  parseWorkspace,
  workspaceKey,
} from '../components/dashboard/canvas-state.ts';

const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const mutate = (change) => {
  const state = initialWorkspace();
  change(state);
  return state;
};

void test('initial rooms and the agreed launch responses survive storage unchanged', () => {
  const state = initialWorkspace();
  assert.equal(workspaceKey, 'conclave-canvas-workspace-v1');
  assert.deepEqual(
    state.rooms.map((room) => room.name),
    ['Launch plan', 'Solana research', 'Website refresh'],
  );
  const room = state.rooms.find((entry) => entry.id === state.activeRoomId);
  assert.equal(room.name, 'Launch plan');
  assert.deepEqual(room.selectedModels, ['claude', 'gemini']);
  assert.deepEqual(
    room.turns[0].answers.map(({ modelId, heading, paragraphs }) => ({
      modelId,
      heading,
      paragraphs,
    })),
    [
      {
        modelId: 'claude',
        heading: 'Test the core loop first.',
        paragraphs: [
          'Invite five people to save a note and find it again. Fix what stops them.',
          'Spend week two inviting a small beta group.',
        ],
      },
      {
        modelId: 'gemini',
        heading: 'Choose a narrow audience.',
        paragraphs: [
          'Pick one group with a shared problem. Build a 30-second demo around their workflow.',
          'Use week two to recruit your first ten users.',
        ],
      },
    ],
  );
  assert.deepEqual(parseWorkspace(roundTrip(state)), state);
});
