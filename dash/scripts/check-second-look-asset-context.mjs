import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assetReducer,
  initialAssetState,
  validAssetMint,
} from '../components/second-look/asset-state.ts';
import {
  draftForToken,
  emptyExitDraft,
} from '../components/second-look/planning-draft.ts';
import {
  exampleTokenReport,
  JUP_MINT,
  SOL_MINT,
} from '../components/second-look/presentation.ts';

test('new account starts with no prior selection, report, or exit intent', () => {
  const old = assetReducer(initialAssetState(false), {
    type: 'exit',
    asset: { mint: SOL_MINT, example: false },
  });
  assert.ok(old.exitIntent);
  assert.deepEqual(initialAssetState(false), {
    asset: null,
    tokenReport: null,
    exitIntent: null,
  });
  assert.deepEqual(initialAssetState(true).asset, {
    mint: JUP_MINT,
    example: true,
  });
});

test('late report for a previous coin cannot replace the selected coin', () => {
  const selected = assetReducer(initialAssetState(false), {
    type: 'select',
    asset: { mint: SOL_MINT, example: false },
  });
  const next = assetReducer(selected, {
    type: 'report',
    report: exampleTokenReport(),
    example: false,
  });
  assert.equal(next.asset.mint, SOL_MINT);
  assert.equal(next.tokenReport.report.mint, JUP_MINT);
});

test('example provenance stays separate even for the same mint', () => {
  const sample = assetReducer(initialAssetState(true), {
    type: 'report',
    report: exampleTokenReport(),
    example: true,
  });
  const live = assetReducer(sample, {
    type: 'select',
    asset: { mint: JUP_MINT, example: false },
  });
  assert.equal(live.asset.example, false);
  assert.equal(live.tokenReport.example, true);
});

test('every explicit exit action carries the intended coin and a fresh revision', () => {
  const first = assetReducer(initialAssetState(true), {
    type: 'exit',
    asset: { mint: SOL_MINT, example: false },
  });
  const next = assetReducer(first, {
    type: 'exit',
    asset: { mint: JUP_MINT, example: true },
  });
  assert.equal(next.asset.mint, JUP_MINT);
  assert.deepEqual(next.exitIntent, {
    mint: JUP_MINT,
    example: true,
    revision: 2,
  });
});

test('invalid public keys cannot enter the shared selection', () => {
  const state = initialAssetState(true);
  for (const mint of ['', 'invalid', '1'.repeat(44), '0'.repeat(32)]) {
    assert.equal(validAssetMint(mint), false);
    assert.equal(
      assetReducer(state, { type: 'select', asset: { mint, example: false } }),
      state,
    );
  }
  assert.equal(validAssetMint(SOL_MINT), true);
});

test('selecting another token clears all asset-specific levels but preserves the wallet', () => {
  const draft = {
    ...emptyExitDraft,
    walletId: 'linked-wallet',
    mint: SOL_MINT,
    target: '250',
    stop: '90',
    trailing: '12',
    targetSize: '50',
    slippage: '8',
  };
  assert.deepEqual(draftForToken(draft, JUP_MINT), {
    ...emptyExitDraft,
    walletId: 'linked-wallet',
    mint: JUP_MINT,
  });
  assert.equal(draftForToken(draft, SOL_MINT), draft);
});

test('explicit exit selection replaces an unfinished different-token draft', () => {
  const selection = assetReducer(initialAssetState(true), {
    type: 'exit',
    asset: { mint: JUP_MINT, example: true },
  });
  const draft = {
    ...emptyExitDraft,
    mint: SOL_MINT,
    target: '230',
    stop: '100',
  };
  const next = draftForToken(draft, selection.exitIntent.mint);
  assert.equal(next.mint, JUP_MINT);
  assert.equal(next.target, '');
  assert.equal(next.stop, '');
});
