import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaClientError } from '../lib/client/media.ts';
import {
  prepareStudioReview,
  quoteStudioReview,
  submitStudioReview,
  changeStudioVariant,
  interruptedStudioReview,
  hasUncertainStudioApproval,
  studioPendingMaximum,
  studioVariantKey,
  isPendingStudioJob,
} from '../lib/client/studio-review.ts';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = uuid(1),
  expiresAt = () => new Date(Date.now() + 120000).toISOString();
const privacy = {
  level: 'unverified',
  provider: 'gateway',
  plaintextVisibility: 'gateway_and_upstream',
  retentionDisclosure:
    'The gateway and upstream provider receive the description.',
};
const choices = {
  runway: [
    { kind: 'video', duration: 5, quality: '720p', aspectRatio: '16:9' },
    { kind: 'video', duration: 10, quality: '720p', aspectRatio: '16:9' },
  ],
  veo: [
    { kind: 'video', duration: 8, quality: 'standard', aspectRatio: '16:9' },
  ],
  kling: [
    { kind: 'video', duration: 5, quality: 'standard', aspectRatio: '16:9' },
  ],
};
const routes = () =>
  Object.entries(choices).map(([family, options], index) => ({
    versionId: uuid(index + 10),
    routeId: `video-${family}`,
    version: 1,
    modelId: {
      runway: 'runway-gen4',
      veo: 'veo3-fast',
      kling: 'kling-2.5-turbo',
    }[family],
    family,
    modality: 'video',
    expiresAt: expiresAt(),
    privacy,
    pricing: {
      kind: 'media-fixed-v1',
      maxInputBytes: 16000,
      markupBps: 500,
      variants: options.map((options) => ({
        options: structuredClone(options),
        providerUsd6: '1000000',
        catalogQuality: options.quality,
        catalogSize: `${options.aspectRatio}_${options.duration}`,
      })),
    },
  }));
const draft = () => ({
  prompt: 'A quiet sea at sunrise.\nKeep the camera still.',
  modelIds: ['runway', 'veo', 'kling'],
  ratio: '16:9',
  duration: '6',
  strict: false,
  reference: null,
});
const prepare = () => prepareStudioReview(draft(), routes(), projectId);
function clientFor(review) {
  let next = 30;
  return {
    quote: async (input) => {
      const entry = review.entries.find(
        (entry) => entry.route.versionId === input.routeVersionId,
      );
      return {
        ...structuredClone(input),
        id: uuid(next++),
        modelId: entry.route.modelId,
        maximumUsd6: '1050000',
        providerMaximumUsd6: '1000000',
        expiresAt: expiresAt(),
        privacy,
        mediaAssetState: 'pending_storage',
        deliveryReady: false,
      };
    },
  };
}
async function quoted() {
  const review = prepare();
  let key = 1;
  return quoteStudioReview(
    review,
    clientFor(review),
    () => `fixture_media_key_${key++}`,
  );
}
function savedJob(entry, review) {
  return {
    id: uuid(100 + review.entries.indexOf(entry)),
    projectId: review.projectId,
    routeVersionId: entry.route.versionId,
    modelId: entry.route.modelId,
    input: {
      prompt: review.prompt,
      privacy: 'standard',
      options: entry.options,
    },
    state: 'queued',
    canRecover: false,
    processingState: 'queued',
    updatedAt: new Date().toISOString(),
  };
}
const track = () => {
  let value;
  return {
    current: () => true,
    update: (review) => {
      value = review;
    },
    value: () => value,
  };
};

void test('draft duration is a preference while exact per-route supported variants remain visible', () => {
  const review = prepare();
  assert.deepEqual(
    review.entries.map((e) => e.options.duration),
    [5, 8, 5],
  );
  assert.equal(review.requestedDuration, '6');
  assert.equal(review.requestedRatio, '16:9');
  assert.equal(
    review.entries.every((e) => !e.quote && !e.approval),
    true,
  );
  const source = draft(),
    available = routes(),
    snapshot = prepareStudioReview(source, available, projectId);
  source.prompt = 'Changed';
  available[0].pricing.variants[0].options.duration = 10;
  assert.equal(snapshot.prompt, draft().prompt);
  assert.equal(snapshot.entries[0].options.duration, 5);
});

void test('unsupported privacy, references, models and ratios are blocked instead of dropped', () => {
  for (const change of [
    { strict: true },
    { reference: { name: 'reference.webp', url: 'blob:fixture' } },
    { modelIds: ['runway', 'sora'] },
    { modelIds: ['runway', 'runway'] },
    { modelIds: [] },
    { ratio: '1:1' },
  ])
    assert.throws(
      () => prepareStudioReview({ ...draft(), ...change }, routes(), projectId),
      MediaClientError,
    );
  const expired = routes().map((r) => ({
    ...r,
    expiresAt: '2000-01-01T00:00:00.000Z',
  }));
  assert.throws(
    () => prepareStudioReview(draft(), expired, projectId),
    MediaClientError,
  );
});

void test('quotes carry exact prompts, variants, distinct immutable keys and summed maximum', async () => {
  const review = await quoted();
  assert.equal(studioPendingMaximum(review), '3150000');
  assert.equal(
    new Set(review.entries.map((e) => e.approval.idempotencyKey)).size,
    3,
  );
  for (const e of review.entries) {
    assert.equal(Object.isFrozen(e.approval), true);
    assert.equal(e.quote.input.prompt, review.prompt);
    assert.deepEqual(e.quote.input.options, e.options);
  }
});

void test('variant changes invalidate every unsubmitted quote and cannot modify uncertain or accepted terms', async () => {
  const review = await quoted(),
    key = studioVariantKey(review.entries[0].route.pricing.variants[1].options);
  const changed = changeStudioVariant(review, 'runway', key);
  assert.equal(changed.entries[0].options.duration, 10);
  assert.equal(studioPendingMaximum(changed), null);
  assert.equal(
    changed.entries.every(
      (e) => e.phase === 'unquoted' && e.quote === null && e.approval === null,
    ),
    true,
  );
  for (const phase of ['uncertain', 'submitting', 'accepted', 'rejected']) {
    const locked = structuredClone(review);
    locked.entries[1].phase = phase;
    assert.throws(
      () => changeStudioVariant(locked, 'runway', key),
      MediaClientError,
    );
  }
});

void test('partial quote failure cannot lead to a silent subset of paid submissions', async () => {
  const review = prepare(),
    good = clientFor(review);
  let calls = 0;
  const partial = await quoteStudioReview(review, {
    quote: async (input) => {
      if (input.routeVersionId === review.entries[1].route.versionId)
        throw new MediaClientError(
          'MEDIA_ROUTE_UNAVAILABLE',
          'Unavailable',
          409,
        );
      return good.quote(input);
    },
  });
  assert.equal(studioPendingMaximum(partial), null);
  await assert.rejects(
    submitStudioReview(
      partial,
      {
        create: async () => {
          calls++;
        },
      },
      track(),
    ),
    MediaClientError,
  );
  assert.equal(calls, 0);
});

void test('mismatched catalog price or returned model cannot become an approvable quote', async () => {
  for (const patch of [
    { maximumUsd6: '1050001' },
    { providerMaximumUsd6: '999999' },
    { modelId: 'other-model' },
  ]) {
    const review = prepare(),
      good = clientFor(review);
    const result = await quoteStudioReview(review, {
      quote: async (input) => ({ ...(await good.quote(input)), ...patch }),
    });
    assert.equal(
      result.entries.every(
        (e) => e.phase === 'unquoted' && e.approval === null,
      ),
      true,
    );
  }
});

void test('partial success stops on ambiguity; recovery touches only unknown keys and never replays accepted jobs', async () => {
  let review = await quoted();
  const calls = [],
    updates = track();
  let rejectSecond = true;
  const create = async (approval) => {
    calls.push(approval.idempotencyKey);
    const entry = review.entries.find(
      (e) => e.approval.idempotencyKey === approval.idempotencyKey,
    );
    if (entry.family === 'veo' && rejectSecond) {
      rejectSecond = false;
      throw new MediaClientError('NETWORK_ERROR', 'Outcome unknown', 0, true);
    }
    return {
      job: savedJob(entry, review),
      replayed: entry.phase === 'uncertain',
    };
  };
  review = await submitStudioReview(review, { create }, updates);
  assert.deepEqual(
    review.entries.map((e) => e.phase),
    ['accepted', 'uncertain', 'quoted'],
  );
  assert.equal(calls.length, 2);
  const originalKey = review.entries[1].approval.idempotencyKey;
  assert.equal(hasUncertainStudioApproval(review), true);
  await assert.rejects(
    quoteStudioReview(review, clientFor(review)),
    MediaClientError,
  );
  review = await submitStudioReview(review, { create }, updates);
  assert.deepEqual(
    review.entries.map((e) => e.phase),
    ['accepted', 'accepted', 'quoted'],
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1], originalKey);
  assert.equal(calls[2], originalKey);
  assert.equal(studioPendingMaximum(review), '1050000');
  review = await submitStudioReview(review, { create }, updates);
  assert.equal(
    review.entries.every((e) => e.phase === 'accepted'),
    true,
  );
  assert.equal(calls.length, 4);
  assert.equal(
    calls.filter((k) => k === review.entries[0].approval.idempotencyKey).length,
    1,
  );
  assert.equal(studioPendingMaximum(review), '0');
});

void test('accepted jobs are preserved when refreshing only rejected or unsubmitted quotes', async () => {
  const review = await quoted();
  const acceptedKey = review.entries[0].approval.idempotencyKey;
  review.entries[0] = {
    ...review.entries[0],
    phase: 'accepted',
    job: savedJob(review.entries[0], review),
  };
  review.entries[1] = { ...review.entries[1], phase: 'rejected' };
  const calls = [],
    good = clientFor(review);
  const refreshed = await quoteStudioReview(review, {
    quote: async (input) => {
      calls.push(input.routeVersionId);
      return good.quote(input);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.includes(review.entries[0].route.versionId), false);
  assert.equal(refreshed.entries[0].approval.idempotencyKey, acceptedKey);
});

void test('scope cancellation leaves the submitted row recoverable and starts no further jobs', async () => {
  const review = await quoted();
  let active = true,
    calls = 0,
    saved;
  await submitStudioReview(
    review,
    {
      create: async () => {
        calls++;
        active = false;
        throw new DOMException('Aborted', 'AbortError');
      },
    },
    {
      current: () => active,
      update: (v) => {
        saved = v;
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(saved.entries[0].phase, 'submitting');
  const interrupted = interruptedStudioReview(saved);
  assert.equal(interrupted.entries[0].phase, 'uncertain');
  assert.equal(
    interrupted.entries[0].approval.idempotencyKey,
    review.entries[0].approval.idempotencyKey,
  );
  assert.equal(interrupted.entries[1].phase, 'quoted');
});

void test('unknown approval recovers after expiry but an untouched expired quote cannot start a job', async () => {
  const review = await quoted();
  let count = 0;
  for (const entry of review.entries)
    entry.quote.expiresAt = '2000-01-01T00:00:00.000Z';
  await assert.rejects(
    submitStudioReview(
      review,
      {
        create: async () => {
          count++;
        },
      },
      track(),
    ),
    MediaClientError,
  );
  assert.equal(count, 0);
  review.entries[0].phase = 'uncertain';
  const result = await submitStudioReview(
    review,
    {
      create: async () => {
        count++;
        return { job: savedJob(review.entries[0], review), replayed: true };
      },
    },
    track(),
  );
  assert.equal(count, 1);
  assert.equal(result.entries[0].phase, 'accepted');
  assert.equal(result.entries[1].phase, 'quoted');
});

void test('foreign accepted response is uncertain and does not start remaining models', async () => {
  const review = await quoted();
  let calls = 0;
  const result = await submitStudioReview(
    review,
    {
      create: async () => {
        calls++;
        return {
          job: { ...savedJob(review.entries[0], review), projectId: uuid(900) },
          replayed: false,
        };
      },
    },
    track(),
  );
  assert.equal(calls, 1);
  assert.equal(result.entries[0].phase, 'uncertain');
  assert.equal(result.entries[1].phase, 'quoted');
});

void test('polling stops for completed delivery and terminal uncertainty without a safe lookup', () => {
  for (const state of ['queued', 'dispatching', 'polling'])
    assert.equal(isPendingStudioJob({ state }), true);
  assert.equal(
    isPendingStudioJob({ state: 'completed', processingState: 'processing' }),
    true,
  );
  assert.equal(
    isPendingStudioJob({ state: 'completed', processingState: 'completed' }),
    false,
  );
  assert.equal(
    isPendingStudioJob({ state: 'reconciliation_pending', canRecover: false }),
    false,
  );
  assert.equal(
    isPendingStudioJob({ state: 'reconciliation_pending', canRecover: true }),
    true,
  );
});
