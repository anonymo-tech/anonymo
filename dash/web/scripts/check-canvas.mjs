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

void test('new rooms are empty and independent; making one never alters another', () => {
  const one = createRoom('Research');
  const two = createRoom('Research');
  assert.notEqual(one.id, two.id);
  assert.deepEqual(one.turns, []);
  assert.equal(one.draft, '');
  one.selectedModels.push('gpt');
  assert.deepEqual(two.selectedModels, ['claude', 'gemini']);
  for (const name of ['', '  ', 'x'.repeat(canvasLimits.roomName + 1), null])
    assert.throws(() => createRoom(name), RangeError);
});

void test('drafts, conversation order, model choices and saved artifacts round trip without truncation', () => {
  const state = initialWorkspace();
  const room = state.rooms[0];
  room.draft = '  Keep my unfinished question.\nAnd this second line.  ';
  room.selectedModels = ['gpt', 'llama'];
  room.turns.push(
    createSampleTurn(canvasPrompts.checklist, ['claude', 'gemini']),
  );
  state.briefs.push(
    createBrief(
      room,
      room.turns[0].answers.map((answer) => answer.id),
    ),
  );
  const restored = parseWorkspace(roundTrip(state));
  assert.deepEqual(restored, state);
  assert.notEqual(restored, state);
  restored.rooms[0].turns[0].answers[0].paragraphs[0] = 'Local edit';
  assert.notEqual(
    restored.rooms[0].turns[0].answers[0].paragraphs[0],
    state.rooms[0].turns[0].answers[0].paragraphs[0],
  );
});

void test('all catalog models can be selected, but custom text never receives a fabricated result', () => {
  for (const { id } of MODELS) {
    const turn = createSampleTurn('Evaluate my unpublished plan in detail.', [
      id,
    ]);
    assert.equal(turn.prompt, 'Evaluate my unpublished plan in detail.');
    assert.equal(turn.answers[0].modelId, id);
    assert.equal(turn.answers[0].heading, 'No live model result.');
    assert.match(
      turn.answers[0].paragraphs.join(' '),
      /no answer has been generated/,
    );
    const room = createRoom('Custom question');
    room.selectedModels = [id];
    room.turns.push(turn);
    assert.ok(
      parseWorkspace({
        version: 1,
        activeRoomId: room.id,
        rooms: [room],
        briefs: [],
      }),
    );
  }
  const partialMatch = createSampleTurn(
    `${canvasPrompts.launch} Also give a personal recommendation.`,
    ['claude'],
  );
  assert.equal(partialMatch.answers[0].heading, 'No live model result.');
});

void test('prepared follow-ups and read-only Solana examples remain explicit and independent', () => {
  const checklist = createSampleTurn(canvasPrompts.checklist, [
    'claude',
    'gemini',
  ]);
  assert.match(checklist.answers[0].paragraphs.join(' '), /Days 1–3/);
  assert.match(checklist.answers[1].paragraphs.join(' '), /Days 8–14/);
  const solana = createSampleTurn(canvasPrompts.solana, ['claude', 'gemini']);
  assert.match(
    solana.answers[0].paragraphs.join(' '),
    /has not decoded or simulated/,
  );
  assert.match(
    solana.answers[1].paragraphs.join(' '),
    /no RPC request, wallet connection, signature, or transaction/,
  );
  checklist.answers[0].paragraphs[0] = 'Changed locally';
  assert.notEqual(
    createSampleTurn(canvasPrompts.checklist, ['claude']).answers[0]
      .paragraphs[0],
    'Changed locally',
  );
});

void test('turn creation rejects unusable prompts and model selections without silently fixing them', () => {
  for (const models of [
    [],
    ['missing'],
    ['__proto__'],
    ['claude', 'claude'],
    MODELS.slice(0, 5).map((model) => model.id),
  ])
    assert.throws(() => createSampleTurn('Question', models), RangeError);
  for (const prompt of ['', '  ', 'x'.repeat(canvasLimits.prompt + 1), null])
    assert.throws(() => createSampleTurn(prompt, ['claude']), RangeError);
});

void test('a malformed record rejects the whole snapshot instead of dropping saved work', () => {
  const changes = [
    (state) => {
      state.version = 2;
    },
    (state) => {
      state.activeRoomId = 'missing-room';
    },
    (state) => {
      state.rooms[1].name = null;
    },
    (state) => {
      state.rooms[1].pinned = 'yes';
    },
    (state) => {
      state.rooms[1].updatedAt = Infinity;
    },
    (state) => {
      state.rooms[1].updatedAt = -1;
    },
    (state) => {
      state.rooms[1].updatedAt = 1.5;
    },
    (state) => {
      state.rooms[1].draft = {};
    },
    (state) => {
      state.rooms[1].selectedModels = ['unknown-model'];
    },
    (state) => {
      state.rooms[1].selectedModels = ['claude', 'claude'];
    },
    (state) => {
      state.rooms[1].turns[0].prompt = '';
    },
    (state) => {
      state.rooms[1].turns[0].answers = [];
    },
    (state) => {
      state.rooms[1].turns[0].answers[0].modelId = 'constructor';
    },
    (state) => {
      state.rooms[1].turns[0].answers[1].modelId = 'claude';
    },
    (state) => {
      state.rooms[1].turns[0].answers[0].paragraphs = [null];
    },
    (state) => {
      const paragraphs = ["First paragraph", "Second paragraph"];
      // A sparse list is the persisted shape under test, so the hole is intended.
      // oxlint-disable-next-line typescript/no-array-delete
      delete paragraphs[0];
      state.rooms[1].turns[0].answers[0].paragraphs = paragraphs;
    },
    (state) => {
      state.rooms[1].unexpected = 'unrecognized persisted field';
    },
  ];
  for (const change of changes) {
    const value = mutate(change);
    const untouchedDraft = value.rooms[0].draft;
    assert.equal(parseWorkspace(value), null);
    assert.equal(value.rooms[0].draft, untouchedDraft);
    assert.equal(value.rooms.length, 3);
  }
  for (const value of [null, false, '{}', [], {}, new Date()])
    assert.equal(parseWorkspace(value), null);
});

void test('IDs stay unique across rooms, turns, answers and artifacts', () => {
  for (const change of [
    (state) => {
      state.rooms[1].id = state.rooms[0].id;
    },
    (state) => {
      state.rooms[1].turns[0].id = state.rooms[0].turns[0].id;
    },
    (state) => {
      state.rooms[1].turns[0].answers[0].id =
        state.rooms[0].turns[0].answers[0].id;
    },
    (state) => {
      state.rooms[1].turns[0].answers[0].id = state.rooms[0].id;
    },
    (state) => {
      state.rooms[1].id = '../other-room';
    },
  ])
    assert.equal(parseWorkspace(mutate(change)), null);
  const state = initialWorkspace();
  const brief = createBrief(state.rooms[0], [
    state.rooms[0].turns[0].answers[0].id,
  ]);
  state.briefs = [{ ...brief, id: state.rooms[1].turns[0].id }];
  assert.equal(parseWorkspace(state), null);
});

void test('brief creation includes only selected answers, copies their text, and rejects cross-room IDs', () => {
  const state = initialWorkspace();
  const room = state.rooms[0];
  const answer = room.turns[0].answers[0];
  const brief = createBrief(room, [answer.id]);
  assert.ok(brief);
  assert.equal(brief.roomId, room.id);
  assert.match(
    brief.body,
    /Local sample comparison\. No live models were called\./,
  );
  assert.ok(brief.body.includes(answer.heading));
  for (const paragraph of answer.paragraphs)
    assert.ok(brief.body.includes(paragraph));
  assert.ok(!brief.body.includes(room.turns[0].answers[1].heading));
  for (const ids of [
    [],
    ['missing-answer'],
    [answer.id, answer.id],
    [answer.id, state.rooms[1].turns[0].answers[0].id],
  ])
    assert.equal(createBrief(room, ids), null);
  const body = brief.body;
  answer.paragraphs[0] = 'A later edit does not rewrite the saved artifact.';
  assert.equal(brief.body, body);
});

void test('brief room references and complete artifact fields are validated on restore', () => {
  const state = initialWorkspace();
  const valid = createBrief(state.rooms[0], [
    state.rooms[0].turns[0].answers[0].id,
  ]);
  state.briefs = [valid];
  assert.ok(parseWorkspace(state));
  for (const patch of [
    { roomId: 'deleted-room' },
    { title: '' },
    { body: '' },
    { createdAt: NaN },
    { createdAt: 8640000000000001 },
  ]) {
    assert.equal(
      parseWorkspace({ ...state, briefs: [{ ...valid, ...patch }] }),
      null,
    );
  }
  assert.equal(parseWorkspace({ ...state, briefs: [valid, valid] }), null);
});

void test('record and total budgets reject oversized storage without truncating text', () => {
  for (const change of [
    (state) => {
      state.rooms[0].draft = 'x'.repeat(canvasLimits.draft + 1);
    },
    (state) => {
      state.rooms[0].turns[0].prompt = 'x'.repeat(canvasLimits.prompt + 1);
    },
    (state) => {
      state.rooms[0].turns[0].answers[0].paragraphs = [
        'x'.repeat(canvasLimits.paragraph + 1),
      ];
    },
    (state) => {
      state.rooms[0].turns[0].answers[0].paragraphs =
        Array(9).fill('Paragraph');
    },
    (state) => {
      state.rooms = Array.from({ length: canvasLimits.rooms + 1 }, (_, index) =>
        createRoom(`Room ${index}`),
      );
    },
    (state) => {
      state.rooms[0].turns = Array.from(
        { length: canvasLimits.turnsPerRoom + 1 },
        () => createSampleTurn('Question', ['claude']),
      );
    },
  ])
    assert.equal(parseWorkspace(mutate(change)), null);
  const state = initialWorkspace();
  const room = state.rooms[0];
  room.turns = Array.from({ length: 30 }, () => {
    const turn = createSampleTurn('Question', ['claude']);
    turn.answers[0].paragraphs = Array(4).fill(
      'x'.repeat(canvasLimits.paragraph),
    );
    return turn;
  });
  assert.equal(
    parseWorkspace(state),
    null,
    'Each record fits, but the complete workspace exceeds its budget',
  );
  assert.equal(room.turns.length, 30);
});

void test('an oversized brief fails without changing its source conversation', () => {
  const room = createRoom('Long room');
  const turn = createSampleTurn('Question', ['claude']);
  turn.answers[0].paragraphs = Array(8).fill('x'.repeat(4000));
  room.turns.push(turn);
  assert.ok(
    parseWorkspace({
      version: 1,
      activeRoomId: room.id,
      rooms: [room],
      briefs: [],
    }),
  );
  const before = roundTrip(room);
  assert.equal(createBrief(room, [turn.answers[0].id]), null);
  assert.deepEqual(room, before);
});
