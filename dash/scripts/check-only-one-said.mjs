import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOnlyOneSaidDraft,
  onlyOneSaidAnswers,
} from '../components/dashboard/only-one-said.ts';
import {
  canvasLimits,
  createSampleTurn,
} from '../components/dashboard/canvas-state.ts';
import { CHAT_LIMITS } from '../lib/chat-limits.ts';
import zh from '../lib/i18n/zh/only-one-said.ts';

const completed = (modelId, index, output = `Point ${index}.`) => ({
  id: `answer-${index}`,
  modelId,
  heading: '',
  paragraphs: [output],
  live: {
    state: 'succeeded',
    modelName: modelId === 'claude' ? 'Claude' : 'Gemini',
    label: `Model ${String.fromCharCode(65 + index)}`,
    output,
  },
});
const turn = {
  id: 'comparison',
  prompt: 'Compare the evidence.',
  answers: [completed('claude', 0), completed('gemini', 1)],
};
const options = {
  turn,
  draft: '',
  instruction:
    'List the points only one answer raised and quote the key phrase.',
  modelName: (answer) => answer.live.modelName,
  answerLabel: (letter) => `Answer ${letter}`,
  maxCharacters: canvasLimits.draft,
  maxBytes: CHAT_LIMITS.inputBytes,
};

test('labels complete answers with model names and defaults to the first answered model', () => {
  const result = buildOnlyOneSaidDraft(options);
  assert.equal(result.status, 'ready');
  assert.equal(
    result.draft,
    `${options.instruction}\n\nClaude:\nPoint 0.\n\nGemini:\nPoint 1.`,
  );
  assert.equal(result.modelId, 'claude');
  assert.equal(
    buildOnlyOneSaidDraft({ ...options, focusedAnswerId: 'answer-1' }).modelId,
    'gemini',
  );
  assert.equal(
    buildOnlyOneSaidDraft({ ...options, focusedAnswerId: 'missing' }).modelId,
    'claude',
  );
});

test('preserves an existing draft verbatim and appends the visible request', () => {
  const draft = 'My existing draft.\n  Keep this spacing.\n';
  const result = buildOnlyOneSaidDraft({ ...options, draft });
  assert.equal(result.status, 'ready');
  assert.equal(
    result.draft,
    `${draft}\n\n${buildOnlyOneSaidDraft(options).draft}`,
  );
  assert.equal(turn.answers[0].live.output, 'Point 0.');
});

test('unrevealed comparisons use neutral A–D labels without looking up identities', () => {
  const answers = ['claude', 'gemini', 'gpt', 'grok'].map((model, index) =>
    completed(model, index),
  );
  const result = buildOnlyOneSaidDraft({
    ...options,
    turn: { ...turn, live: { blind: true }, answers },
    focusedAnswerId: 'answer-1',
    modelName: () => assert.fail('Hidden identity must not be read'),
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.modelId, null);
  for (const letter of ['A', 'B', 'C', 'D'])
    assert.ok(result.draft.includes(`Answer ${letter}:`));
  assert.doesNotMatch(result.draft, /Claude|Gemini|gpt|grok/);
  const masked = {
    ...turn,
    answers: turn.answers.map((answer) => ({ ...answer, modelId: 'blind' })),
  };
  assert.match(
    buildOnlyOneSaidDraft({ ...options, turn: masked }).draft,
    /Answer A:/,
  );
});

test('revealed comparisons may use names again', () => {
  const result = buildOnlyOneSaidDraft({
    ...options,
    turn: {
      ...turn,
      live: { blind: true, revealedAt: '2026-10-15T00:00:00Z' },
    },
  });
  assert.match(result.draft, /Claude:/);
  assert.equal(result.modelId, 'claude');
});

test('ignores incomplete, failed, empty and truncated outputs, preserving blind positions', () => {
  const mixed = {
    ...turn,
    live: { blind: true },
    answers: [
      {
        ...completed('claude', 0),
        live: { ...completed('claude', 0).live, state: 'failed' },
      },
      completed('gemini', 1),
      {
        ...completed('gpt', 2),
        live: { ...completed('gpt', 2).live, outputTruncated: true },
      },
      completed('grok', 3),
    ],
  };
  const result = buildOnlyOneSaidDraft({ ...options, turn: mixed });
  assert.match(result.draft, /Answer B:/);
  assert.match(result.draft, /Answer D:/);
  assert.doesNotMatch(result.draft, /Answer A:|Answer C:/);
  for (const state of [
    'queued',
    'running',
    'cancelled',
    'reconciliation_pending',
  ]) {
    assert.equal(
      onlyOneSaidAnswers({
        ...turn,
        answers: [
          { ...completed('claude', 0), live: { state, output: 'Partial' } },
        ],
      }).length,
      0,
    );
  }
  const draft = 'Do not replace this.';
  assert.deepEqual(
    buildOnlyOneSaidDraft({
      ...options,
      draft,
      turn: {
        ...turn,
        answers: [completed('claude', 0), completed('gemini', 1, '  ')],
      },
    }),
    { status: 'unavailable', draft },
  );
});

test('character overflow leaves the existing draft unchanged, including at the local limit', () => {
  const draft = 'Keep my draft.';
  const expectedLength = buildOnlyOneSaidDraft({ ...options, draft }).draft
    .length;
  assert.equal(
    buildOnlyOneSaidDraft({ ...options, draft, maxCharacters: expectedLength })
      .status,
    'ready',
  );
  assert.deepEqual(
    buildOnlyOneSaidDraft({
      ...options,
      draft,
      maxCharacters: expectedLength - 1,
    }),
    { status: 'too-long', draft },
  );
  const fullDraft = 'x'.repeat(canvasLimits.draft);
  assert.deepEqual(buildOnlyOneSaidDraft({ ...options, draft: fullDraft }), {
    status: 'too-long',
    draft: fullDraft,
  });
});

test('byte overflow preserves the draft and uses UTF-8 rather than character count', () => {
  const draft = '已有草稿';
  const instruction = Object.entries(zh).find(([key]) =>
    key.startsWith('List the points'),
  )[1];
  const chinese = {
    ...options,
    draft,
    instruction,
    answerLabel: (letter) => zh['Answer {letter}'].replace('{letter}', letter),
  };
  const result = buildOnlyOneSaidDraft(chinese);
  assert.equal(result.status, 'ready');
  assert.ok(result.draft.includes(instruction));
  assert.match(result.draft, /Point 0\./);
  const bytes = new TextEncoder().encode(result.draft).byteLength;
  assert.ok(bytes > result.draft.length);
  assert.equal(
    buildOnlyOneSaidDraft({ ...chinese, maxBytes: bytes }).status,
    'ready',
  );
  assert.deepEqual(buildOnlyOneSaidDraft({ ...chinese, maxBytes: bytes - 1 }), {
    status: 'too-long',
    draft,
  });
});

test('sample text answers are supported but empty preview placeholders are excluded', () => {
  const sample = createSampleTurn(
    'How should I launch my notes app in two weeks?',
    ['claude', 'gemini'],
  );
  const result = buildOnlyOneSaidDraft({
    ...options,
    turn: sample,
    modelName: (answer) => answer.modelId,
  });
  assert.equal(result.status, 'ready');
  assert.ok(result.draft.includes(sample.answers[0].heading));
  const placeholders = createSampleTurn('A question without a sample answer.', [
    'claude',
    'gemini',
  ]);
  assert.equal(onlyOneSaidAnswers(placeholders).length, 0);
});

test('a second click on the same comparison does not duplicate the draft', () => {
  const sample = createSampleTurn(
    'How should I launch my notes app in two weeks?',
    ['claude', 'gemini'],
  );
  const first = buildOnlyOneSaidDraft({ ...options, turn: sample, modelName: (answer) => answer.modelId });
  assert.equal(first.status, 'ready');
  const second = buildOnlyOneSaidDraft({ ...options, turn: sample, draft: first.draft, modelName: (answer) => answer.modelId });
  assert.equal(second.status, 'ready');
  assert.equal(second.draft, first.draft);
});
