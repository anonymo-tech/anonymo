import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  findProgramAddress,
  associatedTokenAddress,
} from '../server/solana/associated-token.ts';
import { TOKEN_PROGRAM, SOLANA_NETWORKS } from '../server/solana/validation.ts';
import { PYTH_SOL_ACCOUNT } from '../server/second-look/wallet-pyth.ts';
import { SOL_MINT } from '../server/second-look/trade-parser.ts';
import {
  createExitPriceSource,
  exitWatchConfig,
  exitWatchCapability,
  exitPriceBounds,
  parseJupiterPrice,
  parsePumpPool,
  parsePumpSnapshot,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  PUMP_CURVE_PROGRAM,
  parseRayPool,
  parseRaySnapshot,
  pumpCurveAddress,
  parsePumpCurveSnapshot,
} from '../server/second-look/exit-sources.ts';
const now = new Date('2026-10-12T12:00:00.000Z'),
  seconds = now.getTime() / 1000;
const encode = (b, owner = TOKEN_PROGRAM) => ({
  owner,
  executable: false,
  data: [b.toString('base64'), 'base64'],
});
function fixture(mintByte = 7) {
  const mint = bs58.encode(Buffer.alloc(32, mintByte)),
    creator = Buffer.alloc(32, 9),
    index = Buffer.from([0, 0]);
  const derived = findProgramAddress(
    [
      Buffer.from('pool'),
      index,
      creator,
      bs58.decode(mint),
      bs58.decode(SOL_MINT),
    ],
    PUMP_SWAP_PROGRAM,
    RAYDIUM_CPMM_PROGRAM,
    PUMP_CURVE_PROGRAM,
    parseRayPool,
    parseRaySnapshot,
    pumpCurveAddress,
    parsePumpCurveSnapshot,
  );
  const baseVault = associatedTokenAddress({
      owner: derived.address,
      mint,
      tokenProgram: TOKEN_PROGRAM,
    }),
    quoteVault = associatedTokenAddress({
      owner: derived.address,
      mint: SOL_MINT,
      tokenProgram: TOKEN_PROGRAM,
    });
  const pool = Buffer.alloc(287);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(pool);
  pool[8] = derived.bump;
  creator.copy(pool, 11);
  Buffer.from(bs58.decode(mint)).copy(pool, 43);
  Buffer.from(bs58.decode(SOL_MINT)).copy(pool, 75);
  Buffer.from(bs58.decode(baseVault)).copy(pool, 139);
  Buffer.from(bs58.decode(quoteVault)).copy(pool, 171);
  function vault(m) {
    const b = Buffer.alloc(165);
    Buffer.from(bs58.decode(m)).copy(b);
    Buffer.from(bs58.decode(derived.address)).copy(b, 32);
    b.writeBigUInt64LE(1000000000n, 64);
    b[108] = 1;
    return b;
  }
  function mintData(decimals) {
    const b = Buffer.alloc(82);
    b[44] = decimals;
    b[45] = 1;
    return b;
  }
  const pyth = Buffer.alloc(134);
  createHash('sha256')
    .update('account:PriceUpdateV2')
    .digest()
    .copy(pyth, 0, 0, 8);
  pyth[40] = 1;
  Buffer.from(
    'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    'hex',
  ).copy(pyth, 41);
  pyth.writeBigInt64LE(10000000000n, 73);
  pyth.writeBigUInt64LE(100n, 81);
  pyth.writeInt32LE(-8, 89);
  pyth.writeBigInt64LE(BigInt(seconds - 5), 93);
  pyth.writeBigInt64LE(BigInt(seconds - 6), 101);
  pyth.writeBigUInt64LE(100n, 125);
  const poolAccount = encode(pool, PUMP_SWAP_PROGRAM),
    snapshot = {
      context: { slot: 100 },
      value: [
        poolAccount,
        encode(vault(mint)),
        encode(vault(SOL_MINT)),
        encode(mintData(6)),
        encode(mintData(9)),
        encode(pyth, 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ'),
      ],
    };
  return { mint, pool, poolAccount, snapshot, poolAddress: derived.address };
}
const config = {
  enabled: true,
  rpcUrl: 'https://rpc.example.test',
  jupiterApiKey: 'fixture-only-api-key',
  pollIntervalMs: 30000,
};

await test('watch configuration is opt-in, mainnet-only, bounded and never exposes API credentials', () => {
  assert.equal(exitWatchCapability().configured, false);
  const cfg = exitWatchConfig({
    CONCLAVE_EXIT_WATCH_ENABLED: 'true',
    CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta',
    CONCLAVE_SOLANA_RPC_URL: 'https://rpc.example.test',
    CONCLAVE_JUPITER_API_KEY: 'fixture-only-api-key',
    CONCLAVE_EXIT_WATCH_INTERVAL_MS: '1',
  });
  assert.equal(cfg.pollIntervalMs, 15000);
  assert.equal(exitWatchCapability(cfg).configured, true);
  assert.ok(
    !JSON.stringify(exitWatchCapability(cfg)).includes('fixture-only-api-key'),
  );
  assert.equal(
    exitWatchCapability({ ...cfg, jupiterApiKey: null }).configured,
    true,
  );
});
await test('Jupiter JSON prices preserve decimal lexemes and exponent precision', () => {
  assert.deepEqual(
    parseJupiterPrice(
      '{"mint":{"usdPrice":0.123456789012345678901,"blockId":100}}',
      'mint',
    ),
    {
      slot: 100,
      price: '0.123456789012345678',
      upperPrice: '0.123456789012345679',
    },
  );
  assert.deepEqual(
    parseJupiterPrice(
      '{"mint":{"usdPrice":1.234567890123456789e-7,"blockId":100}}',
      'mint',
    ),
    {
      slot: 100,
      price: '0.000000123456789012',
      upperPrice: '0.000000123456789013',
    },
  );
  assert.throws(() => parseJupiterPrice('{}', 'mint'));
  assert.throws(() =>
    parseJupiterPrice('{"mint":{"usdPrice":0,"blockId":100}}', 'mint'),
  );
});
await test('repeating reserve ratios round outward while exact prices stay exact', () => {
  assert.deepEqual(exitPriceBounds(1n, 3n), {
    price: '0.333333333333333333',
    upperPrice: '0.333333333333333334',
  });
  assert.deepEqual(exitPriceBounds(1n, 10n), {
    price: '0.1',
    upperPrice: '0.1',
  });
});
await test('primary quote verifies official pool PDA, vault mints/owners and Pyth source', () => {
  const f = fixture(),
    pool = parsePumpPool(f.poolAddress, f.poolAccount),
    quote = parsePumpSnapshot(pool, f.snapshot, seconds - 1, now);
  assert.equal(quote.price, '0.1');
  assert.equal(quote.upperPrice, '0.1');
  assert.equal(quote.observedAt, new Date((seconds - 5) * 1000).toISOString());
  for (const mutate of [
    (f) => {
      f.poolAccount.owner = TOKEN_PROGRAM;
    },
    (f) => {
      f.pool[8] ^= 1;
      f.poolAccount.data[0] = f.pool.toString('base64');
    },
    (f) => {
      f.pool[243] = 1;
      f.poolAccount.data[0] = f.pool.toString('base64');
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => parsePumpPool(f.poolAddress, f.poolAccount));
  }
  const wrongVault = structuredClone(f.snapshot);
  wrongVault.value[1].owner = PUMP_SWAP_PROGRAM;
  assert.throws(() => parsePumpSnapshot(pool, wrongVault, seconds - 1, now));
  assert.throws(() => parsePumpSnapshot(pool, f.snapshot, seconds - 31, now));
});
await test('virtual quote reserves from the official layout affect the observed price', () => {
  const f = fixture();
  f.pool.writeBigInt64LE(1000000000n, 245);
  f.poolAccount.data[0] = f.pool.toString('base64');
  assert.equal(
    parsePumpSnapshot(
      parsePumpPool(f.poolAddress, f.poolAccount),
      f.snapshot,
      seconds - 1,
      now,
    ).price,
    '0.2',
  );
});
function market(f, liquidity = 20000) {
  return {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: f.poolAddress,
    baseToken: { address: f.mint },
    quoteToken: { address: SOL_MINT },
    liquidity: { usd: liquidity },
  };
}
function mockSource(
  f,
  markets = [market(f)],
  extras = new Map(),
  price = '0.1',
) {
  const methods = [],
    pool = parsePumpPool(f.poolAddress, f.poolAccount);
  const accounts = new Map([
    [f.poolAddress, f.poolAccount],
    [pool.baseVault, f.snapshot.value[1]],
    [pool.quoteVault, f.snapshot.value[2]],
    [f.mint, f.snapshot.value[3]],
    [SOL_MINT, f.snapshot.value[4]],
    [PYTH_SOL_ACCOUNT, f.snapshot.value[5]],
    ...extras,
  ]);
  const mock = async (url, init) => {
    if (url === config.rpcUrl) {
      const req = JSON.parse(init.body);
      methods.push(req.method);
      const result =
        req.method === 'getGenesisHash'
          ? SOLANA_NETWORKS['mainnet-beta'].genesisHash
          : req.method === 'getMultipleAccounts'
            ? {
                context: { slot: 100 },
                value: req.params[0].map((key) => accounts.get(key) ?? null),
              }
            : seconds - 1;
      return Response.json({ jsonrpc: '2.0', id: req.id, result });
    }
    if (url.startsWith('https://api.jup.ag/'))
      return new Response(
        `{"${new URL(url).searchParams.get('ids')}":{"usdPrice":${price},"blockId":99}}`,
      );
    return Response.json(markets);
  };
  return { mock, methods };
}
await test('source performs bounded read-only calls and stamps Jupiter with its block time', async () => {
  const f = fixture(),
    { mock, methods } = mockSource(f);
  const pair = await createExitPriceSource(config, mock).read(f.mint, now);
  assert.equal(pair.reason, null);
  assert.equal(pair.primary.price, '0.1');
  assert.equal(pair.crosscheck.price, '0.1');
  assert.equal(
    pair.crosscheck.observedAt,
    new Date((seconds - 1) * 1000).toISOString(),
  );
  assert.deepEqual(methods, [
    'getGenesisHash',
    'getMultipleAccounts',
    'getMultipleAccounts',
    'getBlockTime',
    'getBlockTime',
  ]);
});
await test('keyless reads need a public rate reservation and never send an empty credential', async () => {
  const f = fixture(),
    { mock } = mockSource(f);
  let jupiterCalls = 0;
  const wrapped = (url, init) => {
    if (url.startsWith('https://api.jup.ag/')) {
      jupiterCalls++;
      assert.equal(init.headers['x-api-key'], undefined);
    }
    return mock(url, init);
  };
  const source = createExitPriceSource(
    { ...config, jupiterApiKey: null },
    wrapped,
    async () => true,
  );
  assert.equal((await source.read(f.mint, now)).reason, null);
  assert.equal(jupiterCalls, 1);
  const limited = createExitPriceSource(
    { ...config, jupiterApiKey: null },
    wrapped,
    async () => false,
  );
  assert.equal(
    (await limited.read(f.mint, now)).reason,
    'EXIT_PUBLIC_RATE_LIMIT',
  );
  assert.equal(jupiterCalls, 1);
});
function rayFixture(mintByte = 7) {
  const f = fixture(mintByte),
    poolAddress = bs58.encode(Buffer.alloc(32, 21)),
    pool = Buffer.alloc(637);
  createHash('sha256').update('account:PoolState').digest().copy(pool, 0, 0, 8);
  const mint0 = [f.mint, SOL_MINT].sort((a, b) =>
      Buffer.compare(bs58.decode(a), bs58.decode(b)),
    )[0],
    mint1 = mint0 === f.mint ? SOL_MINT : f.mint;
  const authority = findProgramAddress(
    [Buffer.from('vault_and_lp_mint_auth_seed')],
    RAYDIUM_CPMM_PROGRAM,
  );
  const vault0 = findProgramAddress(
    [Buffer.from('pool_vault'), bs58.decode(poolAddress), bs58.decode(mint0)],
    RAYDIUM_CPMM_PROGRAM,
  ).address;
  const vault1 = findProgramAddress(
    [Buffer.from('pool_vault'), bs58.decode(poolAddress), bs58.decode(mint1)],
    RAYDIUM_CPMM_PROGRAM,
  ).address;
  for (const [offset, key] of [
    [72, vault0],
    [104, vault1],
    [168, mint0],
    [200, mint1],
    [232, TOKEN_PROGRAM],
    [264, TOKEN_PROGRAM],
  ])
    Buffer.from(bs58.decode(key)).copy(pool, offset);
  pool[328] = authority.bump;
  pool[331] = mint0 === SOL_MINT ? 9 : 6;
  pool[332] = mint1 === SOL_MINT ? 9 : 6;
  const vault = (mint, amount) => {
    const b = Buffer.alloc(165);
    Buffer.from(bs58.decode(mint)).copy(b);
    Buffer.from(bs58.decode(authority.address)).copy(b, 32);
    b.writeBigUInt64LE(amount, 64);
    b[108] = 1;
    return encode(b);
  };
  const mintData = (m) =>
    m === SOL_MINT ? f.snapshot.value[4] : f.snapshot.value[3];
  const poolAccount = encode(pool, RAYDIUM_CPMM_PROGRAM);
  const snapshot = {
    context: { slot: 100 },
    value: [
      poolAccount,
      vault(mint0, mint0 === SOL_MINT ? 3000000000n : 2000000000n),
      vault(mint1, mint1 === SOL_MINT ? 3000000000n : 2000000000n),
      mintData(mint0),
      mintData(mint1),
      f.snapshot.value[5],
    ],
  };
  return {
    ...f,
    rayPool: pool,
    rayAddress: poolAddress,
    rayAccount: poolAccount,
    raySnapshot: snapshot,
    mint0,
    mint1,
    vault0,
    vault1,
  };
}
await test('Raydium CPMM uses either token order and subtracts protocol, fund, and creator fees', () => {
  for (const mintByte of [1, 7]) {
    const f = rayFixture(mintByte),
      sol0 = f.mint0 === SOL_MINT;
    // SOL reserve is 3 SOL before 1 SOL total accrued fees: 2 SOL / 2000 tokens * $100.
    f.rayPool.writeBigUInt64LE(200000000n, sol0 ? 341 : 349);
    f.rayPool.writeBigUInt64LE(300000000n, sol0 ? 357 : 365);
    f.rayPool.writeBigUInt64LE(500000000n, sol0 ? 397 : 405);
    f.rayAccount.data[0] = f.rayPool.toString('base64');
    assert.equal(
      parseRaySnapshot(
        parseRayPool(f.rayAddress, f.rayAccount),
        f.raySnapshot,
        f.mint,
        seconds - 1,
        now,
      ).price,
      '0.1',
    );
    const wrong = structuredClone(f.raySnapshot),
      b = Buffer.from(wrong.value[1].data[0], 'base64');
    b.fill(0, 32, 64);
    wrong.value[1].data[0] = b.toString('base64');
    assert.throws(() =>
      parseRaySnapshot(
        parseRayPool(f.rayAddress, f.rayAccount),
        wrong,
        f.mint,
        seconds - 1,
        now,
      ),
    );
    f.rayPool[329] = 4;
    f.rayAccount.data[0] = f.rayPool.toString('base64');
    assert.throws(() => parseRayPool(f.rayAddress, f.rayAccount));
  }
});
await test('pool selection verifies actual SOL reserves instead of trusting discovery liquidity or price', async () => {
  const f = rayFixture();
  const extras = new Map([
    [f.rayAddress, f.rayAccount],
    [f.vault0, f.raySnapshot.value[1]],
    [f.vault1, f.raySnapshot.value[2]],
  ]);
  const markets = [
    market(f, 999999999),
    {
      ...market(f, 1),
      dexId: 'raydium',
      pairAddress: f.rayAddress,
      priceUsd: '99999',
    },
  ];
  const { mock, methods } = mockSource(f, markets, extras, '0.15');
  const pair = await createExitPriceSource(config, mock).read(f.mint, now);
  assert.equal(pair.reason, null);
  assert.equal(pair.primary.source, 'raydium_cpmm_rpc_pyth');
  assert.equal(pair.primary.price, '0.15');
  assert.equal(methods.filter((m) => m === 'getMultipleAccounts').length, 2);
});
function curveFixture() {
  const f = fixture(),
    curve = Buffer.alloc(166);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(curve);
  curve.writeBigUInt64LE(1000000000n, 8);
  curve.writeBigUInt64LE(1000000000n, 16);
  curve.writeBigUInt64LE(500000000n, 24);
  curve.writeBigUInt64LE(500000000n, 32);
  const account = encode(curve, PUMP_CURVE_PROGRAM);
  return {
    ...f,
    curve,
    curveAccount: account,
    curveSnapshot: {
      context: { slot: 100 },
      value: [account, f.snapshot.value[3], f.snapshot.value[5]],
    },
  };
}
await test('incomplete canonical Pump curve uses virtual reserves and refuses complete, foreign quote, or mayhem curves', () => {
  const f = curveFixture();
  assert.equal(
    parsePumpCurveSnapshot(f.mint, f.curveSnapshot, seconds - 1, now).price,
    '0.1',
  );
  for (const offset of [48, 81, 83]) {
    const f = curveFixture();
    f.curve[offset] = 1;
    f.curveAccount.data[0] = f.curve.toString('base64');
    assert.throws(() =>
      parsePumpCurveSnapshot(f.mint, f.curveSnapshot, seconds - 1, now),
    );
  }
});
await test('ungraduated tokens use their canonical curve when no supported DEX pool is present', async () => {
  const f = curveFixture(),
    { mock } = mockSource(
      f,
      [],
      new Map([[pumpCurveAddress(f.mint), f.curveAccount]]),
    );
  const pair = await createExitPriceSource(config, mock).read(f.mint, now);
  assert.equal(pair.reason, null);
  assert.equal(pair.primary.source, 'pump_bonding_rpc_pyth');
});
await test('SOL itself is priced by the verified Pyth feed without DEX discovery', async () => {
  const f = fixture(),
    { mock } = mockSource(f, [], new Map(), '100');
  let discovery = 0;
  const wrapped = (url, init) => {
    if (url.includes('dexscreener')) discovery++;
    return mock(url, init);
  };
  const pair = await createExitPriceSource(config, wrapped).read(SOL_MINT, now);
  assert.equal(pair.reason, null);
  assert.equal(pair.primary.source, 'pyth_sol_rpc');
  assert.equal(pair.primary.price, '100');
  assert.equal(discovery, 0);
});
await test('future or stale Pyth timestamps and uninitialized mints never trigger a price', () => {
  const f = fixture(),
    pool = parsePumpPool(f.poolAddress, f.poolAccount);
  for (const timestamp of [seconds + 1, seconds - 31]) {
    const snapshot = structuredClone(f.snapshot),
      pyth = Buffer.from(snapshot.value[5].data[0], 'base64');
    pyth.writeBigInt64LE(BigInt(timestamp), 93);
    pyth.writeBigInt64LE(BigInt(timestamp - 1), 101);
    snapshot.value[5].data[0] = pyth.toString('base64');
    assert.throws(() => parsePumpSnapshot(pool, snapshot, seconds - 1, now));
  }
  const wrongMint = structuredClone(f.snapshot),
    bytes = Buffer.from(wrongMint.value[3].data[0], 'base64');
  bytes[45] = 0;
  wrongMint.value[3].data[0] = bytes.toString('base64');
  assert.throws(() => parsePumpSnapshot(pool, wrongMint, seconds - 1, now));
});
