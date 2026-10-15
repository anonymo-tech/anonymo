import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  inspectSignature,
  parseSignatureInput,
} from '../server/second-look/signature.ts';
import {
  readDomainAge,
  signatureReferences,
} from '../server/second-look/signature-reputation.ts';
import {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  SOLANA_NETWORKS,
} from '../server/solana/validation.ts';
const key = (n) => bs58.encode(Buffer.alloc(32, n));
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const short = (n) => {
  const out = [];
  do {
    const byte = n & 127;
    n >>>= 7;
    out.push(byte | (n ? 128 : 0));
  } while (n);
  return Buffer.from(out);
};
function wire({
  keys = [key(1), key(2), SYSTEM_PROGRAM],
  header = [1, 0, 1],
  instructions = [
    { program: 2, indexes: [0, 1], data: Buffer.concat([u32(2), u64(50)]) },
  ],
} = {}) {
  return Buffer.concat([
    short(header[0]),
    Buffer.alloc(64 * header[0]),
    Buffer.from(header),
    short(keys.length),
    ...keys.map((v) => Buffer.from(bs58.decode(v))),
    Buffer.alloc(32, 9),
    short(instructions.length),
    ...instructions.flatMap((i) => [
      Buffer.from([i.program]),
      short(i.indexes.length),
      Buffer.from(i.indexes),
      short(i.data.length),
      i.data,
    ]),
  ]).toString('base64');
}
function rpc(options = {}) {
  const methods = [];
  const call = async (method) => {
    methods.push(method);
    if (method === 'getGenesisHash')
      return options.genesis ?? SOLANA_NETWORKS.devnet.genesisHash;
    assert.equal(method, 'simulateTransaction');
    return {
      context: { slot: 500 },
      value: {
        err: null,
        accounts: null,
        innerInstructions: null,
        preBalances: [1000, 100, 1],
        postBalances: [940, 150, 1],
        preTokenBalances: [],
        postTokenBalances: [],
        ...options.value,
      },
    };
  };
  return { methods, call };
}
const inspect = (transaction, source, extra = {}) =>
  inspectSignature(
    { kind: 'transaction', transaction, encoding: 'base64', ...extra },
    { cluster: 'devnet', rpc: source.call },
  );
const flag = (r, c) => r.findings.some((f) => f.code === c);
test('transaction shows exact same-simulation signer SOL changes without claiming safety', async () => {
  const r = await inspect(wire(), rpc());
  assert.equal(r.balances.status, 'complete');
  assert.equal(r.balances.signers[0].sol.deltaLamports, '-60');
  assert.equal(r.verdict, 'caution');
  assert.equal(r.coverage.signsOrSubmits, false);
});
test('base58 transaction is normalized and all signer accounts receive deltas', async () => {
  const transaction = wire({ header: [2, 0, 1] });
  const source = rpc();
  const r = await inspectSignature(
    {
      kind: 'transaction',
      transaction: bs58.encode(Buffer.from(transaction, 'base64')),
      encoding: 'base58',
    },
    { cluster: 'devnet', rpc: source.call },
  );
  assert.equal(r.balances.signers.length, 2);
  assert.equal(r.balances.signers[1].sol.deltaLamports, '50');
});
test('unsafe numeric balances and omitted balances are never zero', async () => {
  for (const value of [
    { preBalances: [Number.MAX_SAFE_INTEGER + 1, 0, 1] },
    { preBalances: [] },
    { preBalances: undefined },
  ]) {
    const r = await inspect(wire(), rpc({ value }));
    assert.equal(r.balances.status, 'unavailable');
    assert.equal(r.balances.signers[0].sol, null);
    assert.ok(flag(r, 'SIGNER_BALANCES_UNKNOWN'));
  }
});
test('full u64 string deltas and token balances remain exact', async () => {
  const token = (amount) => ({
    accountIndex: 1,
    mint: key(8),
    owner: key(1),
    programId: TOKEN_PROGRAM,
    uiTokenAmount: { amount, decimals: 6, uiAmount: 1 },
  });
  const r = await inspect(
    wire(),
    rpc({
      value: {
        preBalances: ['18446744073709551615', 100, 1],
        postBalances: ['18446744073709551614', 100, 1],
        preTokenBalances: [token('18446744073709551615')],
        postTokenBalances: [token('18446744073709551614')],
      },
    }),
  );
  assert.equal(r.balances.signers[0].sol.deltaLamports, '-1');
  assert.equal(r.balances.signers[0].tokens[0].deltaAmount, '-1');
});
test('token owner change records loss for the original signer without mint rounding', async () => {
  const row = (owner) => ({
    accountIndex: 1,
    mint: key(8),
    owner,
    uiTokenAmount: { amount: '9007199254740993', decimals: 9 },
  });
  const r = await inspect(
    wire(),
    rpc({
      value: {
        preTokenBalances: [row(key(1))],
        postTokenBalances: [row(key(6))],
      },
    }),
  );
  assert.equal(
    r.balances.signers[0].tokens[0].deltaAmount,
    '-9007199254740993',
  );
});
test('duplicate token metadata and mismatched mint make token coverage unknown', async () => {
  const row = {
    accountIndex: 1,
    mint: key(8),
    owner: key(1),
    uiTokenAmount: { amount: '20', decimals: 6 },
  };
  for (const value of [
    { preTokenBalances: [row, row] },
    { preTokenBalances: [row], postTokenBalances: [{ ...row, mint: key(9) }] },
  ]) {
    const r = await inspect(wire(), rpc({ value }));
    assert.equal(r.balances.status, 'partial');
    assert.equal(r.balances.tokenCoverage, 'unavailable');
    assert.deepEqual(r.balances.signers[0].tokens, []);
  }
});
test('System Assign and token owner authority changes remain prominent', async () => {
  const assign = wire({
    instructions: [
      {
        program: 2,
        indexes: [0],
        data: Buffer.concat([u32(1), Buffer.from(bs58.decode(key(7)))]),
      },
    ],
  });
  assert.ok(flag(await inspect(assign, rpc()), 'SYSTEM_ASSIGN'));
  const owner = wire({
    keys: [key(1), key(2), TOKEN_PROGRAM],
    instructions: [
      {
        program: 2,
        indexes: [1, 0],
        data: Buffer.concat([
          Buffer.from([6, 2, 1]),
          Buffer.from(bs58.decode(key(7))),
        ]),
      },
    ],
  });
  const result = await inspect(owner, rpc());
  assert.ok(flag(result, 'TOKEN_ACCOUNT_TAKEOVER'));
  assert.equal(result.permissions.length, 1);
});
test('classic and Token-2022 approvals flag delegate spending permission', async () => {
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const input = wire({
      keys: [key(1), key(2), key(3), program],
      instructions: [
        {
          program: 3,
          indexes: [1, 2, 0],
          data: Buffer.concat([Buffer.from([4]), u64(1000)]),
        },
      ],
    });
    const r = await inspect(
      input,
      rpc({
        value: { preBalances: [100, 100, 0, 1], postBalances: [90, 100, 0, 1] },
      }),
    );
    assert.ok(
      flag(
        r,
        program === TOKEN_PROGRAM ? 'TOKEN_DELEGATE' : 'TOKEN_2022_DELEGATE',
      ),
    );
    assert.equal(r.verdict, 'looks_like_a_drainer');
  }
});
test('swap intent flags a transfer outside explicitly supplied recipients', async () => {
  const r = await inspect(wire(), rpc(), {
    intent: 'swap',
    expectedRecipients: [key(4)],
  });
  assert.ok(flag(r, 'SWAP_EXTRA_TRANSFER'));
  assert.equal(
    flag(
      await inspect(wire(), rpc(), {
        intent: 'swap',
        expectedRecipients: [key(2)],
      }),
      'SWAP_EXTRA_TRANSFER',
    ),
    false,
  );
});
test('nonce is recognized and original blockhash is retained', async () => {
  const input = wire({
    keys: [
      key(1),
      key(2),
      'SysvarRecentB1ockHashes11111111111111111111',
      SYSTEM_PROGRAM,
    ],
    header: [1, 0, 2],
    instructions: [{ program: 3, indexes: [1, 2, 0], data: u32(4) }],
  });
  const source = rpc({
    value: { preBalances: [100, 100, 1, 1], postBalances: [100, 100, 1, 1] },
  });
  const r = await inspect(input, source);
  assert.ok(flag(r, 'DURABLE_NONCE'));
  assert.equal(r.transaction.simulation.blockhashReplacementRequested, false);
});
test('transaction-shaped message is flagged without any RPC', async () => {
  const r = await inspectSignature({
    kind: 'message',
    message: wire(),
    pageOrigin: null,
  });
  assert.ok(flag(r, 'MESSAGE_IS_TRANSACTION'));
  assert.equal(r.transaction, null);
});
test('a raw transaction message preimage is not mistaken for harmless sign-in text', async () => {
  const bytes = Buffer.from(wire(), 'base64').subarray(65);
  for (const message of [bytes.toString('base64'), bs58.encode(bytes)]) {
    const r = await inspectSignature({
      kind: 'message',
      message,
      pageOrigin: null,
    });
    assert.ok(flag(r, 'MESSAGE_IS_TRANSACTION'));
    assert.equal(r.transaction, null);
  }
});
test('SIWS compares supplied page, URI and domain; absent page remains unknown', async () => {
  const message = `trade.example wants you to sign in with your Solana account:\n${key(1)}\n\nURI: https://trade.example/login\nVersion: 1\nNonce: sample1234`;
  assert.ok(
    flag(
      await inspectSignature({
        kind: 'message',
        message,
        pageOrigin: 'https://other.example',
      }),
      'SIWS_DOMAIN_MISMATCH',
    ),
  );
  assert.ok(
    flag(
      await inspectSignature({
        kind: 'message',
        message,
        pageOrigin: 'https://trade.example',
      }),
      'SIWS_DOMAIN_MATCH',
    ),
  );
  assert.ok(
    flag(
      await inspectSignature({ kind: 'message', message, pageOrigin: null }),
      'SIWS_PAGE_UNKNOWN',
    ),
  );
});
test('permission messages and encoded terms remain cautions', async () => {
  const r = await inspectSignature({
    kind: 'message',
    message: 'I grant permission under these terms: ' + 'a'.repeat(80),
    pageOrigin: null,
  });
  assert.ok(flag(r, 'MESSAGE_PERMISSION_TERMS'));
  assert.ok(flag(r, 'MESSAGE_EMBEDDED_DATA'));
});
test('lookalike, homoglyph and extra-word hosts are flagged, exact host is not green', async () => {
  for (const url of [
    'https://fom0.family',
    'https://fоmo.family',
    'https://fomo-login.com',
    'https://fomo.family.evil.example',
  ])
    assert.ok(
      flag(await inspectSignature({ kind: 'domain', url }), 'DOMAIN_LOOKALIKE'),
    );
  const r = await inspectSignature({
    kind: 'domain',
    url: 'https://fomo.family',
  });
  assert.equal(r.domain.lookalike, false);
  assert.equal(r.domain.rdap, 'unknown');
  assert.equal(r.verdict, 'caution');
});
test('local and credential-bearing URLs, unknown request fields and secrets reject', async () => {
  for (const url of [
    'http://127.0.0.1',
    'https://user:pass@example.com',
    'file:///etc/passwd',
  ])
    assert.throws(() => parseSignatureInput({ kind: 'domain', url }));
  assert.throws(() =>
    parseSignatureInput({
      kind: 'app',
      packageName: 'family.fomo.app',
      endpoint: 'https://example.com',
    }),
  );
  await assert.rejects(
    inspectSignature({
      kind: 'message',
      message: entropyToMnemonic(new Uint8Array(16), wordlist),
      pageOrigin: null,
    }),
    (e) => e.code === 'SENSITIVE_INPUT',
  );
});
test('official subdomains are not lookalikes but misleading suffixes still are', async () => {
  for (const url of [
    'https://app.fomo.family',
    'https://www.pump.fun',
    'https://swap.pump.fun',
    'https://docs.jup.ag',
  ]) {
    const report = await inspectSignature({ kind: 'domain', url });
    assert.equal(report.domain.lookalike, false);
    assert.equal(report.verdict, 'caution');
    assert.ok(report.coverage.unknowns.includes('certificate-ownership'));
  }
  for (const url of [
    'https://swap.pump.fun.evil.example',
    'https://pump-fun.com',
    'https://app.fom0.family',
  ]) {
    const report = await inspectSignature({ kind: 'domain', url });
    assert.ok(flag(report, 'DOMAIN_LOOKALIKE'));
  }
});
test('app inspection accepts canonical Play listings without fetching arbitrary links', async () => {
  const report = await inspectSignature({
    kind: 'app',
    packageName:
      'https://play.google.com/store/apps/details?id=family.fomo.app&hl=en',
  });
  assert.equal(report.app.packageName, 'family.fomo.app');
  assert.equal(report.app.certificate, 'unknown');
  assert.equal(report.verdict, 'caution');
  for (const packageName of [
    'https://play.google.com.evil.example/store/apps/details?id=family.fomo.app',
    'http://play.google.com/store/apps/details?id=family.fomo.app',
    'https://play.google.com/store/apps/details?id=family.fomo.app&id=other.app',
    'https://play.google.com/store/apps/details',
    'https://play.google.com/store/apps/details?id=family.fomo.app#other.app',
    'https://play.google.com:8443/store/apps/details?id=family.fomo.app',
  ])
    assert.throws(() => parseSignatureInput({ kind: 'app', packageName }));
});
test('wrong cluster rejects before simulation and aborted inspection does not dispatch', async () => {
  const source = rpc({ genesis: SOLANA_NETWORKS['mainnet-beta'].genesisHash });
  await assert.rejects(inspect(wire(), source));
  assert.deepEqual(source.methods, ['getGenesisHash']);
  const other = rpc();
  await assert.rejects(
    inspectSignature(
      { kind: 'transaction', transaction: wire(), encoding: 'base64' },
      { cluster: 'devnet', rpc: other.call, signal: AbortSignal.abort() },
    ),
  );
  assert.equal(other.methods.length, 0);
});
test('reviewed references require freshness and licensed commercial use', async () => {
  const now = Date.now(),
    reviewedAt = new Date(now - 1000).toISOString(),
    expiresAt = new Date(now + 10000).toISOString();
  const document = {
    version: 1,
    blocklist: {
      domains: ['bad.example'],
      wallets: [],
      source: 'https://evidence.example/list',
      license: 'CC0-1.0',
      commercialUse: 'allowed',
      reviewedAt,
      expiresAt,
    },
    apps: [
      {
        packageName: 'family.fomo.app',
        certificateSha256: ['a'.repeat(64)],
        listing:
          'https://play.google.com/store/apps/details?id=family.fomo.app',
        reviewedAt,
        expiresAt,
      },
    ],
  };
  const refs = signatureReferences(
    { CONCLAVE_SIGNATURE_REFERENCES: JSON.stringify(document) },
    now,
  );
  assert.ok(refs.blocklist);
  assert.equal(refs.apps.length, 1);
  assert.ok(
    flag(
      await inspectSignature(
        { kind: 'domain', url: 'https://bad.example' },
        { references: refs },
      ),
      'DOMAIN_BLOCKLISTED',
    ),
  );
  assert.equal(
    (
      await inspectSignature(
        {
          kind: 'app',
          packageName: 'family.fomo.app',
          certificateSha256: 'a'.repeat(64),
        },
        { references: refs },
      )
    ).app.certificate,
    'match',
  );
  assert.ok(
    flag(
      await inspectSignature(
        {
          kind: 'app',
          packageName: 'family.fomo.app',
          certificateSha256: 'b'.repeat(64),
        },
        { references: refs },
      ),
      'APP_CERTIFICATE_MISMATCH',
    ),
  );
  document.blocklist.commercialUse = 'unknown';
  assert.equal(
    signatureReferences(
      { CONCLAVE_SIGNATURE_REFERENCES: JSON.stringify(document) },
      now,
    ).blocklist,
    null,
  );
  document.blocklist.commercialUse = 'allowed';
  document.apps[0].expiresAt = new Date(now - 1).toISOString();
  assert.equal(
    signatureReferences(
      { CONCLAVE_SIGNATURE_REFERENCES: JSON.stringify(document) },
      now,
    ).apps.length,
    0,
  );
});
test('RDAP uses fixed registry hosts, binds domain, rejects redirects and times out', async () => {
  let calls = 0;
  const now = Date.now();
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(
      url,
      'https://rdap.identitydigital.services/rdap/domain/fomo.family',
    );
    assert.equal(init.redirect, 'error');
    return Response.json({
      objectClassName: 'domain',
      ldhName: 'fomo.family',
      events: [
        {
          eventAction: 'registration',
          eventDate: new Date(now - 5 * 86400000).toISOString(),
        },
      ],
    });
  };
  assert.equal(
    (await readDomainAge('fomo.family', { now, fetcher })).ageDays,
    5,
  );
  assert.equal(await readDomainAge('127.0.0.1', { fetcher }), null);
  assert.equal(calls, 1);
  assert.equal(
    await readDomainAge('fomo.family', {
      fetcher: async () =>
        Response.json({
          objectClassName: 'domain',
          ldhName: 'other.family',
          events: [],
        }),
    }),
    null,
  );
  assert.equal(
    await readDomainAge('fomo.family', {
      timeoutMs: 5,
      fetcher: () => new Promise(() => {}),
    }),
    null,
  );
});
test('RDAP looks up the registered domain for supported subdomains and .fun', async () => {
  const now = Date.now();
  for (const [host, registered, base] of [
    [
      'app.fomo.family',
      'fomo.family',
      'https://rdap.identitydigital.services/rdap/domain/',
    ],
    ['swap.pump.fun', 'pump.fun', 'https://rdap.radix.host/rdap/domain/'],
  ]) {
    const result = await readDomainAge(host, {
      now,
      fetcher: async (url) => {
        assert.equal(url, base + registered);
        return Response.json({
          objectClassName: 'domain',
          ldhName: registered,
          events: [
            {
              eventAction: 'registration',
              eventDate: new Date(now - 86400000).toISOString(),
            },
          ],
        });
      },
    });
    assert.equal(result.ageDays, 1);
    assert.equal(result.source, base + registered);
  }
  assert.equal(
    await readDomainAge('jup.ag', {
      fetcher: async () => {
        assert.fail('unsupported registry fetched');
      },
    }),
    null,
  );
});

const { actionEndpoint, signatureActionEndpoints, resolveSignatureAction } =
  await import('../server/second-look/signature-actions.ts');
const actionUrl = 'https://actions.example.com/donate';
const actionNow = Date.now();
const actionRows = (urls = [actionUrl]) =>
  urls.map((url) => ({
    url,
    cluster: 'devnet',
    source: 'https://solana.com/docs/tools/actions',
    reviewedAt: new Date(actionNow - 1000).toISOString(),
    expiresAt: new Date(actionNow + 60000).toISOString(),
  }));
const actionMetadata = {
  type: 'action',
  title: 'Transfer example',
  description: 'Synthetic fixture',
  label: 'Inspect',
  icon: 'https://images.example.com/icon.png',
};
test('Action config is exact, fresh and network-bound; missing configuration never fetches', async () => {
  const env = {
    CONCLAVE_SIGNATURE_ACTIONS: JSON.stringify({
      version: 1,
      endpoints: actionRows(),
    }),
  };
  assert.equal(signatureActionEndpoints(env, actionNow).length, 1);
  assert.equal(signatureActionEndpoints(env, actionNow + 70000).length, 0);
  assert.equal(
    signatureActionEndpoints(
      {
        CONCLAVE_SIGNATURE_ACTIONS: JSON.stringify({
          version: 1,
          endpoints: actionRows(['https://127.0.0.1/action']),
        }),
      },
      actionNow,
    ).length,
    0,
  );
  for (const options of [
    { endpoints: [] },
    { endpoints: actionRows(), cluster: 'mainnet-beta' },
  ])
    await assert.rejects(
      resolveSignatureAction(
        { url: actionUrl, account: key(1) },
        {
          cluster: 'devnet',
          now: () => actionNow,
          fetcher: async () => {
            assert.fail('unreviewed endpoint fetched');
          },
          ...options,
        },
      ),
      (e) => e.code === 'ACTION_NOT_REVIEWED',
    );
});
test('Action and Blink syntax unwrap only the target and reject ambiguous or local URLs', () => {
  assert.equal(actionEndpoint('solana-action:' + actionUrl), actionUrl);
  assert.equal(
    actionEndpoint(
      'https://dial.to/?action=' +
        encodeURIComponent('solana-action:' + actionUrl),
    ),
    actionUrl,
  );
  for (const value of [
    'https://dial.to/?action=x&action=y',
    'solana-action:http://localhost/x',
    'https://user:password@example.com/x',
    'https://[::1]/x',
    'https://127.0.0.1/x',
  ])
    assert.throws(() => actionEndpoint(value));
});
test('reviewed root Action requests only unsigned bytes then inspects exact signer balances', async () => {
  const calls = [],
    source = rpc();
  const report = await inspectSignature(
    {
      kind: 'action',
      url:
        'https://dial.to/?action=' +
        encodeURIComponent('solana-action:' + actionUrl),
      account: key(1),
    },
    {
      cluster: 'devnet',
      rpc: source.call,
      now: () => actionNow,
      actionEndpoints: actionRows(),
      fetcher: async (url, init) => {
        calls.push([url, init.method]);
        assert.equal(url, actionUrl);
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        if (init.method === 'GET') {
          assert.equal(init.body, undefined);
          return Response.json(actionMetadata);
        }
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(init.body), { account: key(1) });
        return Response.json({
          transaction: wire(),
          type: 'transaction',
          links: {
            next: { type: 'post', href: 'https://unreviewed.example.com/next' },
          },
        });
      },
    },
  );
  assert.deepEqual(calls, [
    [actionUrl, 'GET'],
    [actionUrl, 'POST'],
  ]);
  assert.equal(report.kind, 'action');
  assert.equal(report.action.endpoint, actionUrl);
  assert.equal(report.action.chainSubmission, false);
  assert.equal(report.balances.signers[0].sol.deltaLamports, '-60');
  assert.ok(flag(report, 'ACTION_IDENTITY_UNVERIFIED'));
  assert.deepEqual(source.methods, ['getGenesisHash', 'simulateTransaction']);
});
test('linked Action requires explicit matching choice and independently allowlisted same-origin target', async () => {
  const target = actionUrl + '?choice=one';
  const metadata = {
    ...actionMetadata,
    links: {
      actions: [{ type: 'transaction', href: '?choice=one', label: 'One' }],
    },
  };
  const fetcher = async (url, init) =>
    init.method === 'GET'
      ? Response.json(metadata)
      : Response.json({ transaction: wire() });
  await assert.rejects(
    resolveSignatureAction(
      { url: actionUrl, account: key(1) },
      {
        cluster: 'devnet',
        endpoints: actionRows([actionUrl, target]),
        now: () => actionNow,
        fetcher,
      },
    ),
    (e) => e.code === 'ACTION_SELECTION_REQUIRED',
  );
  await assert.rejects(
    resolveSignatureAction(
      { url: actionUrl, account: key(1), actionHref: '?choice=one' },
      {
        cluster: 'devnet',
        endpoints: actionRows(),
        now: () => actionNow,
        fetcher,
      },
    ),
  );
  const resolved = await resolveSignatureAction(
    { url: actionUrl, account: key(1), actionHref: '?choice=one' },
    {
      cluster: 'devnet',
      endpoints: actionRows([actionUrl, target]),
      now: () => actionNow,
      fetcher,
    },
  );
  assert.equal(resolved.provenance.transactionEndpoint, target);
  for (const linked of [
    { href: 'https://other.example.com/action' },
    { href: '?choice=one', parameters: [{ name: 'amount' }] },
    { href: '?choice=one', type: 'message' },
  ]) {
    let posts = 0;
    await assert.rejects(
      resolveSignatureAction(
        { url: actionUrl, account: key(1), actionHref: linked.href },
        {
          cluster: 'devnet',
          endpoints: actionRows([
            actionUrl,
            target,
            'https://other.example.com/action',
          ]),
          now: () => actionNow,
          fetcher: async (url, init) => {
            if (init.method === 'POST') posts++;
            return Response.json({
              ...actionMetadata,
              links: { actions: [linked] },
            });
          },
        },
      ),
    );
    assert.equal(posts, 0);
  }
});
test('Action wrong signer, malformed response, disabled endpoint and oversized metadata never reach RPC', async () => {
  for (const fixture of [
    'signer',
    'message',
    'disabled',
    'oversized',
    'redirect',
  ]) {
    const source = rpc();
    let requests = 0;
    await assert.rejects(
      inspectSignature(
        { kind: 'action', url: actionUrl, account: key(1) },
        {
          cluster: 'devnet',
          rpc: source.call,
          now: () => actionNow,
          actionEndpoints: actionRows(),
          fetcher: async (url, init) => {
            requests++;
            if (fixture === 'redirect')
              return new Response(null, {
                status: 302,
                headers: { location: 'https://other.example.com/' },
              });
            if (init.method === 'GET')
              return Response.json({
                ...actionMetadata,
                ...(fixture === 'disabled' ? { disabled: true } : {}),
                ...(fixture === 'oversized'
                  ? { description: 'x'.repeat(33000) }
                  : {}),
              });
            return Response.json(
              fixture === 'signer'
                ? {
                    transaction: wire({
                      keys: [key(3), key(2), SYSTEM_PROGRAM],
                    }),
                  }
                : { type: 'message', message: 'sign this' },
            );
          },
        },
      ),
    );
    assert.equal(source.methods.length, 0);
    assert.equal(
      requests,
      fixture === 'signer' || fixture === 'message' ? 2 : 1,
    );
  }
});
test('Action fetch and response-body deadlines are bounded independently of abort cooperation', async () => {
  const options = {
    cluster: 'devnet',
    endpoints: actionRows(),
    now: () => actionNow,
    timeoutMs: 5,
  };
  await assert.rejects(
    resolveSignatureAction(
      { url: actionUrl, account: key(1) },
      { ...options, fetcher: () => new Promise(() => {}) },
    ),
  );
  await assert.rejects(
    resolveSignatureAction(
      { url: actionUrl, account: key(1) },
      {
        ...options,
        fetcher: async () =>
          new Response(new ReadableStream({ start() {} }), {
            headers: { 'content-type': 'application/json' },
          }),
      },
    ),
  );
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    resolveSignatureAction(
      { url: actionUrl, account: key(1) },
      {
        ...options,
        signal: controller.signal,
        fetcher: async () => {
          calls++;
          return Response.json(actionMetadata);
        },
      },
    ),
  );
  assert.equal(calls, 0);
});
test('domain and app records carry reviewed evidence without claiming fetched APK identity', async () => {
  const reviewedAt = new Date(actionNow - 1000).toISOString(),
    expiresAt = new Date(actionNow + 60000).toISOString();
  const references = {
    blocklist: {
      domains: ['example.com'],
      wallets: [],
      source: 'https://sources.example.com/list',
      license: 'fixture',
      reviewedAt,
      expiresAt,
    },
    apps: [
      {
        packageName: 'com.example.app',
        certificateSha256: ['a'.repeat(64)],
        listing:
          'https://play.google.com/store/apps/details?id=com.example.app',
        reviewedAt,
        expiresAt,
      },
    ],
  };
  const domain = await inspectSignature(
    { kind: 'domain', url: 'https://example.com' },
    { references, now: () => actionNow },
  );
  assert.equal(domain.domain.sources[0].url, references.blocklist.source);
  assert.equal(domain.domain.sources[0].expiresAt, expiresAt);
  const app = await inspectSignature(
    {
      kind: 'app',
      packageName: 'com.example.app',
      certificateSha256: 'a'.repeat(64),
    },
    { references, now: () => actionNow },
  );
  assert.equal(app.app.sources[0].observedAt, reviewedAt);
  assert.ok(app.coverage.unknowns.includes('apk-content'));
});
