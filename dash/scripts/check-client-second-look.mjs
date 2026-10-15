import test from 'node:test';
import assert from 'node:assert/strict';
import {
  secondLookRequest,
  decimalAmount,
  usd6,
} from '../lib/client/second-look.ts';
import {
  quoteResponse,
  reportResponse,
  reportsResponse,
  pnlResponse,
  signatureResponse,
  safeEvidenceUrl,
  tokenCapabilitiesResponse,
  signatureCapabilitiesResponse,
} from '../lib/client/second-look-contracts.ts';
import {
  exampleTokenReport,
  walletFeeRows,
} from '../components/second-look/presentation.ts';
import { inspectSignature } from '../server/second-look/signature.ts';
const accountId = '9876412c-974e-4f16-8aa4-183e20a73c76';
const other = '20a5e4a1-89cc-4d25-9cca-c1d46ee20a37';
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const quote = {
  id: accountId,
  mint: exampleTokenReport().mint,
  mode: 'standard',
  maximumUsd6: '20000',
  expiresAt: new Date().toISOString(),
  freeRemaining: 0,
  limitations: [],
};
function transport(callback) {
  let n = 0;
  return async (url, init) => {
    if (url === '/api/auth/session') {
      n++;
      return json({
        accountId: typeof callback === 'string' && n > 1 ? callback : accountId,
        identities: [],
      });
    }
    return typeof callback === 'function'
      ? callback(url, init)
      : json({ quote });
  };
}
test('requests pin account, cookies and no-store; exact quote parsed', async () => {
  let called = 0;
  const result = await secondLookRequest('second-look/tokens/check', {
    accountId,
    body: { mint: quote.mint },
    validate: quoteResponse,
    fetch: transport((url, init) => {
      called++;
      assert.equal(init.headers['X-Conclave-Account-Id'], accountId);
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      return json({ quote });
    }),
  });
  assert.equal(result.quote.maximumUsd6, '20000');
  assert.equal(called, 1);
});
test('account switch after response is rejected instead of rendered', async () => {
  await assert.rejects(
    secondLookRequest('second-look/tokens/check', {
      accountId,
      validate: quoteResponse,
      fetch: transport(other),
    }),
    (e) => e.code === 'SESSION_CHANGED',
  );
});
test('account mismatch before request cannot mutate', async () => {
  let sent = false;
  await assert.rejects(
    secondLookRequest('second-look/wallets', {
      accountId,
      validate: quoteResponse,
      fetch: async (url) => {
        if (url !== '/api/auth/session') sent = true;
        return json({ accountId: other, identities: [] });
      },
    }),
    (e) => e.code === 'SESSION_CHANGED',
  );
  assert.equal(sent, false);
});
test('malformed, oversized and provider HTML are rejected', async () => {
  for (const response of [
    () =>
      new Response('<html>error</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    () => json({ quote: { ...quote, maximumUsd6: 1 } }),
    () => json({ padding: 'a'.repeat(1100000) }),
  ])
    await assert.rejects(
      secondLookRequest('second-look/reports', {
        accountId,
        validate: quoteResponse,
        fetch: transport(response),
      }),
      (e) => e.code === 'INVALID_RESPONSE',
    );
});
test('failure output never echoes provider values or secrets', async () => {
  try {
    await secondLookRequest('second-look/reports', {
      accountId,
      validate: quoteResponse,
      fetch: transport(() =>
        json(
          {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'private server details',
            },
          },
          500,
        ),
      ),
    });
    assert.fail();
  } catch (error) {
    assert.equal(error.message.includes('private server'), false);
  }
});
test('uncertain server failures preserve recovery while unavailable sources give useful next steps', async () => {
  for (const [code, status, expected] of [
    ['INTERNAL_ERROR', 503, 'outcome may be unknown'],
    ['TOKEN_DEEP_UNAVAILABLE', 503, 'Try a standard check'],
    ['ACTION_NOT_REVIEWED', 503, 'transaction bytes instead'],
    ['SENSITIVE_INPUT', 400, 'Remove private keys'],
  ]) {
    await assert.rejects(
      secondLookRequest('second-look/reports', {
        accountId,
        validate: reportResponse,
        fetch: transport(() =>
          json({ error: { code, message: 'private backend details' } }, status),
        ),
      }),
      (error) =>
        error.message.includes(expected) &&
        !error.message.includes('private backend'),
    );
  }
});
test('capabilities accept disabled sources without accepting contradictory activation claims', () => {
  const token = {
    configured: true,
    deepConfigured: false,
    calibrationConfigured: false,
    reason: null,
    dailyFreeChecks: 10,
    standardUsd6: '20000',
    deepUsd6: '100000',
    providers: {
      rpc: true,
      market: true,
      externalRisk: true,
      indexedEvidence: false,
      simulation: false,
      claims: false,
    },
  };
  assert.equal(tokenCapabilitiesResponse({ token }), true);
  assert.equal(
    tokenCapabilitiesResponse({
      token: { ...token, configured: false, deepConfigured: true },
    }),
    false,
  );
  assert.equal(
    tokenCapabilitiesResponse({
      token: { ...token, providers: { ...token.providers, simulation: 'yes' } },
    }),
    false,
  );
  const signature = {
    available: true,
    transactionSimulation: false,
    transactionEncodings: ['base64', 'base58'],
    domainLookalikes: true,
    rdap: true,
    blocklists: false,
    appCertificateRegistry: false,
    actionUrlResolution: false,
    signsOrSubmits: false,
  };
  assert.equal(signatureCapabilitiesResponse(signature), true);
  assert.equal(
    signatureCapabilitiesResponse({ ...signature, actionUrlResolution: true }),
    false,
  );
  assert.equal(
    signatureCapabilitiesResponse({ ...signature, signsOrSubmits: true }),
    false,
  );
});
test('partial fee display preserves combined network cost without double counting split fees', () => {
  const fees = {
    networkUsd6: null,
    priorityUsd6: null,
    networkAndPriorityUsd6: '30000',
    jitoTipUsd6: null,
    platformUsd6: '0',
  };
  const partial = walletFeeRows(fees);
  assert.deepEqual(partial[0], ['Network & priority fees · combined', '30000']);
  assert.equal(partial.length, 3);
  const split = walletFeeRows({
    ...fees,
    networkUsd6: '10000',
    priorityUsd6: '20000',
  });
  assert.equal(split.length, 4);
  assert.deepEqual(split.slice(0, 2), [
    ['Network fees', '10000'],
    ['Priority fees', '20000'],
  ]);
  assert.ok(!split.some(([label]) => label.includes('combined')));
  assert.equal(
    walletFeeRows({ ...fees, networkAndPriorityUsd6: null })[0][1],
    null,
  );
});
test('relative paths only and pagination is bounded', async () => {
  for (const path of [
    'https://example.com',
    'second-look/../auth',
    'second-look/reports?url=https://example.com',
  ])
    await assert.rejects(
      secondLookRequest(path, { accountId, validate: quoteResponse }),
      (e) => e.code === 'INVALID_PATH',
    );
  await assert.rejects(
    secondLookRequest('second-look/reports', {
      accountId,
      cursor: '../not-a-cursor',
      validate: quoteResponse,
    }),
    (e) => e.code === 'INVALID_CURSOR',
  );
});
test('report nested contracts reject unsafe render shapes and duplicate checks', () => {
  const valid = exampleTokenReport();
  assert.equal(reportResponse({ report: valid }), true);
  assert.equal(reportsResponse({ reports: [valid], nextCursor: null }), true);
  for (const mutate of [
    (r) => (r.state = 'green'),
    (r) => (r.checks[0].id = 2),
    (r) => (r.billing.state = 'paid'),
    (r) => (r.billing.maximumUsd6 = null),
    (r) => (r.billing.reconciliationPending = 'yes'),
    (r) => (r.verdict = ['caution']),
    (r) => (r.calibration.baseRate = 8),
    (r) =>
      (r.deep = {
        status: 'complete',
        claims: [],
        limitations: [],
        launch: { events: 'bad' },
      }),
  ]) {
    const v = structuredClone(valid);
    mutate(v);
    assert.equal(reportResponse({ report: v }), false);
  }
});
test('exact amounts do not lose precision and null is not zero', () => {
  assert.equal(
    decimalAmount('123456789012345678901234567', 6),
    '123,456,789,012,345,678,901.23',
  );
  assert.equal(usd6(null), '—');
  assert.equal(usd6('0'), '$0.00');
  assert.equal(usd6('-1020000'), '−$1.02');
});
test('launch replay bounds every event to its declared 100-slot window', () => {
  const report = exampleTokenReport();
  report.deep = {
    status: 'partial',
    claims: [],
    limitations: [],
    launch: {
      createSlot: '100',
      throughSlot: '199',
      truncated: false,
      events: [
        {
          slot: '100',
          signature: 'fixture',
          kind: 'buy',
          amount: '1',
          wallet: null,
          clusterId: null,
          stillHoldingRaw: null,
        },
      ],
    },
  };
  assert.equal(reportResponse({ report }), true);
  report.deep.launch.events[0].slot = '200';
  assert.equal(reportResponse({ report }), false);
  report.deep.launch.events[0].slot = '100';
  report.deep.launch.throughSlot = '98';
  assert.equal(reportResponse({ report }), false);
});
test('P&L cannot mark partial history as a complete total', () => {
  const p = {
    walletId: accountId,
    accounting: 'fifo',
    periodStart: new Date().toISOString(),
    asOf: new Date().toISOString(),
    coverage: 'partial',
    complete: false,
    netUsd6: null,
    realizedUsd6: null,
    unrealizedChangeUsd6: null,
    observed: {
      netUsd6: null,
      realizedUsd6: null,
      unrealizedChangeUsd6: null,
      feesUsd6: null,
    },
    fees: {
      networkUsd6: null,
      priorityUsd6: null,
      networkAndPriorityUsd6: null,
      jitoTipUsd6: null,
      platformUsd6: null,
    },
    rentExcludedLamports: '0',
    positions: [],
    exceptions: [],
    finalizedTransactions: 0,
    activity: [],
    activityTruncated: false,
  };
  assert.equal(pnlResponse({ pnl: p }), true);
  assert.equal(
    pnlResponse({ pnl: { ...p, complete: true, netUsd6: '0' } }),
    false,
  );
  assert.equal(pnlResponse({ pnl: { ...p, netUsd6: '500' } }), false);
  assert.equal(pnlResponse({ pnl: { ...p, observed: {} } }), false);
  assert.equal(
    pnlResponse({ pnl: { ...p, rentExcludedLamports: '-2039280' } }),
    true,
  );
  const position = {
    mint: quote.mint,
    decimals: 6,
    amount: '12',
    missingBasis: true,
    airdrop: false,
    estimated: false,
    basisUsd6: null,
    valueUsd6: '0',
    unrealizedUsd6: null,
    market: 'no_market',
  };
  assert.equal(pnlResponse({ pnl: { ...p, positions: [position] } }), true);
  for (const change of [
    { missingBasis: false },
    { valueUsd6: '500' },
    { decimals: 30 },
  ])
    assert.equal(
      pnlResponse({ pnl: { ...p, positions: [{ ...position, ...change }] } }),
      false,
    );
});
test('real signature output round-trips and rejects invalid nested app/domain', async () => {
  const report = await inspectSignature({
    kind: 'message',
    message: 'Sign in to example.com',
    pageOrigin: null,
  });
  assert.equal(signatureResponse({ report }), true);
  assert.equal(
    signatureResponse({ report: { ...report, domain: { asciiHost: 42 } } }),
    false,
  );
  assert.equal(
    signatureResponse({ report: { ...report, app: { packageName: {} } } }),
    false,
  );
});
test('evidence navigation permits HTTPS without URL credentials', () => {
  assert.equal(safeEvidenceUrl('javascript:alert(1)'), null);
  assert.equal(safeEvidenceUrl('https://name:pass@example.com'), null);
  assert.equal(safeEvidenceUrl('https://solscan.io/'), 'https://solscan.io/');
});
