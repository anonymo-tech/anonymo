import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  parseProgramInspection,
  programAddress,
  ProgramReaderError,
  readProgramInspection,
  programReaderErrorMessage,
} from '../lib/client/program-reader.ts';
import {
  PROGRAM_LOADER_IDS,
  PROGRAM_WARNING_SEVERITY,
} from '../lib/solana/program-reader.ts';

const key = (n) => bs58.encode(new Uint8Array(32).fill(n));
const signature = (n) => bs58.encode(new Uint8Array(64).fill(n));
const address = key(1),
  accountId = '00000000-0000-4000-8000-000000000001';
const copy = (v) => structuredClone(v);
const warning = (code) => ({
  code,
  severity: PROGRAM_WARNING_SEVERITY[code],
  message: `Read-only fixture warning: ${code}.`,
});
const event = (overrides = {}) => ({
  signature: signature(1),
  slot: 100,
  blockTime: 1760000000,
  kind: 'upgrade',
  instruction: '0',
  loader: 'v3',
  ...overrides,
});
function fixture() {
  return {
    readerVersion: '1',
    cluster: 'devnet',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    address,
    contextSlot: 110,
    finality: 'finalized',
    exists: true,
    owner: PROGRAM_LOADER_IDS.v3,
    executable: true,
    loader: 'v3',
    status: 'deployed',
    programDataAddress: key(2),
    authority: { status: 'present', address: key(3) },
    mutability: 'upgradeable',
    lastDeploymentSlot: 100,
    loaderStateSlot: null,
    nextVersionAddress: null,
    verifiedBuild: 'not-checked',
    history: {
      status: 'bounded',
      address: key(2),
      limit: 8,
      scannedSignatures: 1,
      verifiedTransactions: 1,
      unavailableTransactions: 0,
      complete: false,
      events: [event()],
    },
    warnings: ['BUILD_UNVERIFIED', 'UPGRADE_AUTHORITY', 'HISTORY_BOUNDED'].map(
      warning,
    ),
  };
}
function plain(status, loader = 'unknown') {
  const value = fixture();
  Object.assign(value, {
    status,
    loader,
    owner: loader === null ? null : (PROGRAM_LOADER_IDS[loader] ?? key(7)),
    executable: status === 'not-found' ? null : status !== 'not-program',
    exists: status !== 'not-found',
    programDataAddress: null,
    authority: { status: 'unknown', address: null },
    mutability: 'unknown',
    lastDeploymentSlot: null,
  });
  value.history = {
    status: 'not-scanned',
    address: null,
    limit: 8,
    scannedSignatures: 0,
    verifiedTransactions: 0,
    unavailableTransactions: 0,
    complete: false,
    events: [],
  };
  value.warnings = [
    'BUILD_UNVERIFIED',
    status === 'not-found'
      ? 'ACCOUNT_NOT_FOUND'
      : status === 'not-program'
        ? 'NOT_PROGRAM'
        : 'UNSUPPORTED_LOADER',
  ].map(warning);
  return value;
}
function loaderFixture(loader, status = 'deployed') {
  const value = fixture();
  Object.assign(value, {
    loader,
    owner: PROGRAM_LOADER_IDS[loader],
    status,
    programDataAddress: null,
    lastDeploymentSlot: null,
  });
  value.history.address = address;
  value.history.events[0].loader = loader;
  value.history.events[0].kind =
    loader === 'v4' ? 'deploy-or-redeploy' : 'deploy';
  if (loader === 'v1' || loader === 'v2' || status === 'finalized') {
    value.authority = { status: 'none', address: null };
    value.mutability = 'immutable';
    value.warnings = ['BUILD_UNVERIFIED', 'HISTORY_BOUNDED'].map(warning);
  }
  if (loader === 'v4') {
    value.loaderStateSlot = 100;
    value.lastDeploymentSlot = status === 'retracted' ? null : 100;
    value.history.events = [];
    value.warnings.push(
      warning('LOADER_VERSION_UNVERIFIED'),
      warning('HISTORY_INCOMPLETE'),
    );
    if (status === 'retracted')
      value.warnings.push(warning('PROGRAM_RETRACTED'));
  }
  return value;
}
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const invalid = (fn) =>
  assert.throws(
    fn,
    (e) => e instanceof ProgramReaderError && e.code === 'INVALID_RESPONSE',
  );

void test('input is one canonical public address; invalid input makes no API call', async () => {
  assert.equal(programAddress(` ${address}\n`), address);
  let calls = 0;
  for (const input of [
    signature(2),
    `https://example.invalid/${address}`,
    '',
    '0'.repeat(44),
    null,
    {},
    `${address} extra`,
  ])
    await assert.rejects(
      readProgramInspection(input, accountId, {
        fetch: async () => {
          calls++;
          return json({ program: fixture() });
        },
      }),
      ProgramReaderError,
    );
  await assert.rejects(
    readProgramInspection(address, 'not-an-account', {
      fetch: async () => {
        calls++;
        return json({ program: fixture() });
      },
    }),
    (e) => e.status === 401,
  );
  assert.equal(calls, 0);
});

void test('accepts known mutable/immutable loaders and distinct unavailable account states', () => {
  assert.deepEqual(parseProgramInspection(fixture(), address), fixture());
  const immutable = fixture();
  immutable.authority = { status: 'none', address: null };
  immutable.mutability = 'immutable';
  immutable.warnings = ['BUILD_UNVERIFIED', 'HISTORY_BOUNDED'].map(warning);
  assert.equal(
    parseProgramInspection(immutable, address).mutability,
    'immutable',
  );
  for (const value of [
    loaderFixture('v1'),
    loaderFixture('v2'),
    loaderFixture('v4'),
    loaderFixture('v4', 'retracted'),
    loaderFixture('v4', 'finalized'),
    plain('not-found', null),
    plain('not-program'),
    plain('unsupported'),
    plain('unsupported', 'native'),
  ])
    assert.deepEqual(parseProgramInspection(value, address), value);
});

void test('binds result address, network genesis, reader version, finality and unverified build', () => {
  for (const patch of [
    { address: key(8) },
    { cluster: 'mainnet-beta' },
    { genesisHash: key(8) },
    { readerVersion: '2' },
    { finality: 'confirmed' },
    { verifiedBuild: 'verified' },
    { verifiedBuild: true },
    { unsafeExtra: true },
  ])
    invalid(() => parseProgramInspection({ ...fixture(), ...patch }, address));
});

void test('rejects primitive coercion, unsafe slots, nullable omissions and unknown enum values', () => {
  for (const patch of [
    { exists: 'true' },
    { executable: 1 },
    { loader: { toString: () => 'v3' } },
    { status: ['deployed'] },
    { contextSlot: '110' },
    { contextSlot: Number.MAX_SAFE_INTEGER + 1 },
    { contextSlot: -0 },
    { mutability: 'safe' },
    { owner: undefined },
    { lastDeploymentSlot: 111 },
  ])
    invalid(() => parseProgramInspection({ ...fixture(), ...patch }, address));
});

void test('requires visible warning codes with their minimum severity', () => {
  for (const code of [
    'BUILD_UNVERIFIED',
    'UPGRADE_AUTHORITY',
    'HISTORY_BOUNDED',
  ]) {
    const value = fixture();
    value.warnings = value.warnings.filter((w) => w.code !== code);
    invalid(() => parseProgramInspection(value, address));
  }
  for (const change of [
    (v) => (v.warnings[0].severity = 'info'),
    (v) => v.warnings.push(warning('BUILD_UNVERIFIED')),
    (v) => (v.warnings[0].code = 'UNKNOWN_WARNING'),
    (v) => (v.warnings[0].message = 'x'.repeat(1025)),
    (v) => (v.warnings[0].message = 'hidden\u0000control'),
  ]) {
    const value = fixture();
    change(value);
    invalid(() => parseProgramInspection(value, address));
  }
});

void test('missing or ordinary accounts cannot claim deployed/immutable state or observed history', () => {
  for (const value of [plain('not-found', null), plain('not-program')]) {
    for (const patch of [
      { status: 'deployed' },
      { mutability: 'immutable' },
      { authority: { status: 'none', address: null } },
      { programDataAddress: key(2) },
      { loaderStateSlot: 1 },
      { nextVersionAddress: key(2) },
      { lastDeploymentSlot: 1 },
    ])
      invalid(() => parseProgramInspection({ ...value, ...patch }, address));
  }
  invalid(() =>
    parseProgramInspection(
      { ...plain('not-found', null), owner: PROGRAM_LOADER_IDS.v3 },
      address,
    ),
  );
  invalid(() =>
    parseProgramInspection({ ...fixture(), exists: false }, address),
  );
  invalid(() =>
    parseProgramInspection(
      { ...plain('not-program'), executable: true },
      address,
    ),
  );
  const missing = plain('not-found', null);
  missing.warnings = [warning('BUILD_UNVERIFIED')];
  invalid(() => parseProgramInspection(missing, address));
});

void test('exact owner and loader state control mutability; native and unknown remain unknown', () => {
  for (const patch of [
    { owner: key(7) },
    { owner: PROGRAM_LOADER_IDS.v4 },
    { loader: 'unknown' },
    { executable: false },
    { programDataAddress: null },
    { nextVersionAddress: key(6) },
    { loaderStateSlot: 100 },
    { authority: { status: 'unknown', address: null } },
    { authority: { status: 'present', address: null } },
    { mutability: 'unknown' },
    { mutability: 'immutable' },
  ])
    invalid(() => parseProgramInspection({ ...fixture(), ...patch }, address));
  for (const value of [plain('unsupported', 'native'), plain('unsupported')])
    invalid(() =>
      parseProgramInspection(
        {
          ...value,
          authority: { status: 'none', address: null },
          mutability: 'immutable',
        },
        address,
      ),
    );
  for (const loader of ['v1', 'v2'])
    invalid(() =>
      parseProgramInspection(
        { ...loaderFixture(loader), status: 'finalized' },
        address,
      ),
    );
});

void test('v4 retraction slot and finalization are separate from latest deployment and upgrade authority', () => {
  const retracted = loaderFixture('v4', 'retracted');
  assert.equal(
    parseProgramInspection(retracted, address).lastDeploymentSlot,
    null,
  );
  invalid(() =>
    parseProgramInspection(
      { ...retracted, lastDeploymentSlot: retracted.loaderStateSlot },
      address,
    ),
  );
  invalid(() =>
    parseProgramInspection({ ...retracted, executable: false }, address),
  );
  const finalized = loaderFixture('v4', 'finalized');
  invalid(() =>
    parseProgramInspection(
      { ...finalized, nextVersionAddress: key(9) },
      address,
    ),
  );
  invalid(() =>
    parseProgramInspection(
      {
        ...finalized,
        authority: { status: 'present', address: key(4) },
        mutability: 'upgradeable',
      },
      address,
    ),
  );
  for (const value of [retracted, finalized]) {
    value.warnings = value.warnings.filter(
      (w) =>
        !['PROGRAM_RETRACTED', 'LOADER_VERSION_UNVERIFIED'].includes(w.code),
    );
    invalid(() => parseProgramInspection(value, address));
  }
});

void test('history must remain bounded, snapshot-bound, unique and in descending slot order', () => {
  const changes = [
    (v) => (v.history.complete = true),
    (v) => (v.history.limit = 9),
    (v) => (v.history.scannedSignatures = 9),
    (v) => (v.history.verifiedTransactions = 2),
    (v) => (v.history.address = address),
    (v) => (v.history.events[0].slot = 111),
    (v) => (v.history.events[0].slot = '100'),
    (v) => (v.history.events[0].loader = 'v2'),
    (v) => (v.history.events[0].instruction = '0.01'),
    (v) => (v.history.events[0].blockTime = -1),
    (v) => v.history.events.push(copy(v.history.events[0])),
    (v) => {
      v.history.scannedSignatures = 2;
      v.history.verifiedTransactions = 2;
      v.history.events.push(event({ signature: signature(3), slot: 101 }));
    },
    (v) =>
      (v.history.events = Array.from({ length: 17 }, (_, i) =>
        event({ instruction: String(i) }),
      )),
  ];
  for (const change of changes) {
    const value = fixture();
    change(value);
    invalid(() => parseProgramInspection(value, address));
  }
});

void test('history kinds match only known current loader instruction families', () => {
  for (const loader of ['v1', 'v2', 'v3', 'v4']) {
    const value = loader === 'v3' ? fixture() : loaderFixture(loader);
    value.history.events = [
      event({
        loader,
        kind: loader === 'v3' ? 'deploy-or-redeploy' : 'upgrade',
      }),
    ];
    invalid(() => parseProgramInspection(value, address));
  }
});

void test('v4 references and history remain uninterpreted without a reviewed loader-version boundary', () => {
  for (const status of ['deployed', 'retracted', 'finalized']) {
    const value = loaderFixture('v4', status);
    assert.equal(
      parseProgramInspection(value, address).nextVersionAddress,
      null,
    );
    for (const code of ['LOADER_VERSION_UNVERIFIED', 'HISTORY_INCOMPLETE']) {
      invalid(() =>
        parseProgramInspection(
          {
            ...value,
            warnings: value.warnings.filter((warning) => warning.code !== code),
          },
          address,
        ),
      );
    }
    invalid(() =>
      parseProgramInspection(
        {
          ...value,
          nextVersionAddress: key(9),
          warnings: [...value.warnings, warning('NEXT_VERSION_UNINSPECTED')],
        },
        address,
      ),
    );
    invalid(() =>
      parseProgramInspection(
        {
          ...value,
          history: {
            ...value.history,
            events: [event({ loader: 'v4', kind: 'deploy-or-redeploy' })],
          },
        },
        address,
      ),
    );
  }
});

void test('unavailable and incomplete histories require warnings without inventing complete coverage', () => {
  const unavailable = fixture();
  unavailable.history = {
    ...unavailable.history,
    status: 'unavailable',
    scannedSignatures: 0,
    verifiedTransactions: 0,
    events: [],
  };
  unavailable.warnings.push(warning('HISTORY_UNAVAILABLE'));
  assert.equal(
    parseProgramInspection(unavailable, address).history.complete,
    false,
  );
  invalid(() =>
    parseProgramInspection(
      {
        ...unavailable,
        history: { ...unavailable.history, scannedSignatures: 1 },
      },
      address,
    ),
  );
  unavailable.warnings.pop();
  invalid(() => parseProgramInspection(unavailable, address));
  const partial = fixture();
  partial.history.scannedSignatures = 2;
  partial.history.unavailableTransactions = 1;
  partial.warnings.push(warning('HISTORY_INCOMPLETE'));
  assert.equal(
    parseProgramInspection(partial, address).history.events.length,
    1,
  );
  partial.warnings.pop();
  invalid(() => parseProgramInspection(partial, address));
});

void test('explicit read posts only the bound public address with same-origin account fencing', async () => {
  let calls = 0;
  const result = await readProgramInspection(` ${address} `, accountId, {
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, '/api/program-inspections');
      assert.equal(options.method, 'POST');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.mode, 'same-origin');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      assert.equal(
        new Headers(options.headers).get('X-Conclave-Account-Id'),
        accountId,
      );
      assert.deepEqual(JSON.parse(options.body), { address });
      return json({ program: fixture() });
    },
  });
  assert.equal(result.address, address);
  assert.equal(calls, 1);
});

void test('abort before starting or after an account transition cannot return an old result', async () => {
  const first = new AbortController();
  first.abort();
  let calls = 0;
  await assert.rejects(
    readProgramInspection(address, accountId, {
      signal: first.signal,
      fetch: async () => {
        calls++;
        return json({ program: fixture() });
      },
    }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(calls, 0);
  const second = new AbortController();
  let resolve,
    cancelled = false;
  const pending = readProgramInspection(address, accountId, {
    signal: second.signal,
    fetch: () => new Promise((ready) => (resolve = ready)),
  });
  second.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(cancelled, true);
});

void test('timeouts cover fetch implementations and bodies that ignore abort without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    readProgramInspection(address, accountId, {
      timeoutMs: 5,
      fetch: () => {
        calls++;
        return new Promise(() => {});
      },
    }),
    (e) => e.code === 'REQUEST_TIMEOUT',
  );
  assert.equal(calls, 1);
  let cancelled = false;
  await assert.rejects(
    readProgramInspection(address, accountId, {
      timeoutMs: 5,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    }),
    (e) => e.code === 'REQUEST_TIMEOUT',
  );
  assert.equal(cancelled, true);
});

void test('bounded JSON rejects malformed MIME, envelope, encoding, declared and actual body sizes', async () => {
  for (const make of [
    () =>
      json({ program: fixture() }, 200, {
        'content-type': 'application/json-not-really',
      }),
    () => json({ wrong: fixture() }),
    () => json({ program: fixture(), raw: 'extra' }),
    () =>
      new Response(Uint8Array.of(0xc0, 0xaf), {
        headers: { 'content-type': 'application/json' },
      }),
    () => json({ program: fixture() }, 200, { 'content-length': '65537' }),
    () => json({ program: fixture() }, 200, { 'content-length': 'broken' }),
    () =>
      new Response(' '.repeat(65537), {
        headers: { 'content-type': 'application/json' },
      }),
  ])
    await assert.rejects(
      readProgramInspection(address, accountId, { fetch: async () => make() }),
      ProgramReaderError,
    );
});

void test('streamed JSON handles multibyte split boundaries with no arbitrary URL or raw-error display', async () => {
  const value = fixture();
  value.warnings[0].message = 'Unverified build · no safety verdict.';
  const bytes = new TextEncoder().encode(JSON.stringify({ program: value }));
  const result = await readProgramInspection(address, accountId, {
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  assert.equal(result.warnings[0].message, value.warnings[0].message);
  const marker = 'synthetic-private-diagnostic';
  for (const status of [400, 403, 429, 503]) {
    await assert.rejects(
      readProgramInspection(address, accountId, {
        fetch: async () =>
          json(
            {
              error: {
                code: 'SOLANA_RPC_UNAVAILABLE',
                message: marker,
                url: `https://example.invalid/${marker}`,
              },
            },
            status,
          ),
      }),
      (error) =>
        error instanceof ProgramReaderError &&
        !programReaderErrorMessage(error).includes(marker),
    );
  }
});

void test('session expiration cancels unread bodies and emits a typed sign-in failure', async () => {
  let cancelled = false;
  await assert.rejects(
    readProgramInspection(address, accountId, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 401 },
        ),
    }),
    (e) => e instanceof ProgramReaderError && e.status === 401,
  );
  assert.equal(cancelled, true);
});
