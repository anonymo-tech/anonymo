import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

// Execute the actual exported state transitions in the component, without a DOM.
// UI imports are removed only for this isolated module; no implementation is copied.
const source = await readFile(
  new URL('../components/second-look/tax-panel.tsx', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
  },
  transformers: {
    after: [
      () => (file) =>
        ts.factory.updateSourceFile(
          file,
          file.statements.filter((node) => !ts.isImportDeclaration(node)),
        ),
    ],
  },
}).outputText;
const {
  readTaxPurchaseIntent: read,
  submitStoredTaxPurchase: submit,
  taxOptionsFingerprint: fingerprint,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
const scope = 'conclave:tax-purchase:v1:fixture',
  noop = () => {};
const intent = (kind = 'steady') => ({
  version: 1,
  key: randomUUID(),
  kind,
  expectedPriceUsd6: kind === 'tax' ? '9000000' : '12000000',
  walletId: kind === 'tax' ? randomUUID() : null,
  year: kind === 'tax' ? 2026 : null,
});
function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
test('lost response survives remount and retries the same request without a second charge', async () => {
  const saved = storage(),
    request = intent(),
    ledger = new Set();
  const charge = async (value) => {
    ledger.add(value.key);
  };
  await assert.rejects(
    submit(
      saved,
      scope,
      null,
      null,
      () => request,
      noop,
      async (value) => {
        assert.deepEqual(read(saved, scope), request);
        await charge(value);
        throw Error('Response lost');
      },
    ),
  );
  const restored = read(saved, scope);
  assert.deepEqual(restored, request);
  const result = await submit(
    saved,
    scope,
    restored,
    null,
    () => assert.fail('Must reuse persisted intent'),
    noop,
    charge,
  );
  assert.equal(result.state, 'confirmed');
  assert.equal(ledger.size, 1);
  assert.equal(read(saved, scope), null);
  assert.equal(saved.getItem(`${scope}:confirmed`), request.key);
});
test('failed durable storage prevents sending a purchase', async () => {
  const saved = storage();
  saved.setItem = () => {
    throw Error('Storage denied');
  };
  await assert.rejects(
    submit(saved, scope, null, null, intent, noop, () =>
      assert.fail('No payment before persistence'),
    ),
  );
});
test('silent failed storage cannot send a purchase', async () => {
  const saved = storage();
  saved.setItem = noop;
  await assert.rejects(
    submit(saved, scope, null, null, intent, noop, () =>
      assert.fail('No payment before persistence'),
    ),
  );
});
test('failed cleanup after confirmation retains the same replayable receipt', async () => {
  const saved = storage(),
    request = intent(),
    ledger = new Set(),
    remove = saved.removeItem;
  saved.removeItem = () => {
    throw Error('Cleanup failed');
  };
  const send = async (value) => {
    ledger.add(value.key);
  };
  await assert.rejects(
    submit(saved, scope, null, null, () => request, noop, send),
  );
  assert.deepEqual(read(saved, scope), request);
  saved.removeItem = remove;
  await submit(
    saved,
    scope,
    read(saved, scope),
    saved.getItem(`${scope}:confirmed`),
    intent,
    noop,
    send,
  );
  assert.equal(ledger.size, 1);
  assert.equal(read(saved, scope), null);
});
test('a second tab queued before confirmation cannot create a duplicate intent after the lock', async () => {
  const saved = storage(),
    request = intent();
  const snapshotBeforeLock = saved.getItem(`${scope}:confirmed`);
  await submit(
    saved,
    scope,
    null,
    snapshotBeforeLock,
    () => request,
    noop,
    async () => {},
  );
  const result = await submit(
    saved,
    scope,
    null,
    snapshotBeforeLock,
    () => assert.fail('Old tab must review status'),
    noop,
    () => assert.fail('No second payment'),
  );
  assert.equal(result.state, 'changed');
  // A deliberate new confirmation after reading the receipt can buy another month.
  const next = await submit(
    saved,
    scope,
    null,
    saved.getItem(`${scope}:confirmed`),
    intent,
    noop,
    async () => {},
  );
  assert.equal(next.state, 'confirmed');
});
test('an existing pending request must be reviewed instead of replaced by a different purchase', async () => {
  const saved = storage(),
    request = intent('tax');
  saved.setItem(scope, JSON.stringify(request));
  const result = await submit(saved, scope, null, null, intent, noop, () =>
    assert.fail('Do not send a different purchase'),
  );
  assert.deepEqual(result, { state: 'changed', intent: request });
  const changed = await submit(
    saved,
    scope,
    { ...request, year: 2025 },
    null,
    intent,
    noop,
    () => assert.fail('Scope changed'),
  );
  assert.equal(changed.state, 'changed');
});
test('tax retries retain original wallet and year even when the form changed', async () => {
  const saved = storage(),
    request = intent('tax');
  saved.setItem(scope, JSON.stringify(request));
  let sent;
  await submit(
    saved,
    scope,
    request,
    null,
    () => ({ ...intent('tax'), year: 2025 }),
    noop,
    async (value) => {
      sent = value;
    },
  );
  assert.deepEqual(sent, request);
});
test('corrupt, oversized or unknown stored fields fail closed without replacing the key', async () => {
  const saved = storage();
  for (const raw of [
    '{',
    'a'.repeat(513),
    JSON.stringify({ ...intent(), secret: 'not allowed' }),
    JSON.stringify({ ...intent('tax'), walletId: '../invalid' }),
  ]) {
    saved.setItem(scope, raw);
    await assert.rejects(
      submit(saved, scope, null, null, intent, noop, () =>
        assert.fail('No payment with unknown status'),
      ),
    );
    assert.equal(saved.getItem(scope), raw);
  }
});
test('preview fingerprint changes with lot amount or evidence but ignores property and list order', () => {
  const selection = {
      disposalId: 'disposal',
      identifiedAt: '2026-01-01T00:00:00.000Z',
      evidenceReference: 'my-record',
      lots: [
        { lotId: 'b', amount: '3' },
        { lotId: 'a', amount: '2' },
      ],
    },
    options = {
      year: 2026,
      jurisdiction: 'US',
      method: 'specific_id',
      selections: [selection],
    },
    key = fingerprint('wallet', options);
  assert.equal(
    key,
    fingerprint('wallet', {
      ...options,
      selections: [
        {
          lots: [...selection.lots].reverse(),
          evidenceReference: selection.evidenceReference,
          identifiedAt: selection.identifiedAt,
          disposalId: selection.disposalId,
        },
      ],
    }),
  );
  assert.notEqual(
    key,
    fingerprint('wallet', {
      ...options,
      selections: [{ ...selection, lots: [{ lotId: 'a', amount: '4' }] }],
    }),
  );
  assert.notEqual(
    key,
    fingerprint('wallet', {
      ...options,
      selections: [{ ...selection, evidenceReference: 'changed' }],
    }),
  );
  assert.notEqual(key, fingerprint('another-wallet', options));
  assert.notEqual(key, fingerprint('wallet', { ...options, year: 2025 }));
});
