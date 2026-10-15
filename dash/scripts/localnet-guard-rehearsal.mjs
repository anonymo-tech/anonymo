// Disposable local-validator rehearsal. All keys, mints, tokens and the router
// are synthetic. No endpoint or keypair from the environment is accepted.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, open, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createGuardChainReader } from '../server/second-look/guard-chain.ts';
import {
  generateKeypair,
  signCompiledMessage,
} from '../server/token/transaction-builder.ts';
import {
  findProgramAddress,
  associatedTokenAddress,
} from '../server/solana/associated-token.ts';
import {
  GUARD_PROGRAM as GUARD,
  ROOM_ANCHOR_PROGRAM as ANCHOR,
  anchorDiscriminator as disc,
  u64,
  encodeGuardQuote,
  guardQuoteDigest,
  guardCosignDigest,
  ed25519Attestation,
  compileGuardMessage,
} from '../server/second-look/guard-transaction.ts';
const run = promisify(execFile),
  SYS = '11111111111111111111111111111111',
  TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  IX = 'Sysvar1nstructions1111111111111111111111111',
  LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111',
  ALT = 'AddressLookupTab1e1111111111111111111111111';
const zero = Buffer.alloc(32),
  pk = (x) => Buffer.from(bs58.decode(x)),
  seed = (x) => Buffer.from(x),
  u16 = (x) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(x);
    return b;
  },
  u32 = (x) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(x);
    return b;
  };
const vec = (b) => Buffer.concat([u32(b.length), b]);
const pda = (program, ...seeds) => findProgramAddress(seeds, program).address;
const meta = (address, writable = false, signer = false) => ({
  address,
  writable,
  signer,
});
const instruction = (program, name, accounts, ...args) => ({
  programId: program,
  accounts,
  data: Buffer.concat([disc(name), ...args]),
});
const limits = (daily = 100000000n, token = 50000000n, loss = 25000000n) =>
  Buffer.concat([
    u64(daily),
    u64(token),
    u64(loss),
    u16(100),
    Buffer.from([3]),
    u32(600),
  ]);
async function free(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
}
let base;
for (let n = 10099; n < 11099; n += 50) {
  if (
    (
      await Promise.all(Array.from({ length: 36 }, (_, i) => free(n + i)))
    ).every(Boolean)
  ) {
    base = n;
    break;
  }
}
assert.ok(base, 'A free local port block is required');
const endpoint = `http://127.0.0.1:${base}`,
  scratch = await mkdtemp(join(tmpdir(), 'conclave-guard-test-'));
const home = generateKeypair(),
  outsider = generateKeypair(),
  quoteMint = generateKeypair(),
  assetMint = generateKeypair(),
  quotes = [generateKeypair(), generateKeypair()],
  cosigner = generateKeypair();
const domain = randomBytes(32),
  vault = pda(GUARD, seed('vault'), home.publicKey),
  config = pda(GUARD, seed('config')),
  position = pda(GUARD, seed('pos'), pk(vault), assetMint.publicKey),
  gas = pda(GUARD, seed('gas'), pk(vault)),
  programData = pda(LOADER, pk(GUARD)),
  pool = pda(JUP, seed('pool'));
const ata = (owner, mint) =>
  associatedTokenAddress({ owner, mint, tokenProgram: TOKEN });
const vaultQuote = ata(vault, quoteMint.address),
  vaultAsset = ata(vault, assetMint.address),
  feeAccount = ata(home.address, quoteMint.address),
  homeAsset = ata(home.address, assetMint.address),
  poolQuote = ata(pool, quoteMint.address),
  poolAsset = ata(pool, assetMint.address);
const table = generateKeypair().address,
  tableKeys = [
    config,
    gas,
    vault,
    position,
    quoteMint.address,
    assetMint.address,
    vaultQuote,
    vaultAsset,
    feeAccount,
    poolQuote,
    poolAsset,
    pool,
    IX,
    TOKEN,
  ];
const tableMeta = Buffer.alloc(56);
tableMeta.writeUInt32LE(1);
tableMeta.writeBigUInt64LE(18446744073709551615n, 4);
const tableFile = join(scratch, 'lookup.json');
await writeFile(
  tableFile,
  JSON.stringify({
    pubkey: table,
    account: {
      lamports: 100000000,
      data: [
        Buffer.concat([tableMeta, ...tableKeys.map(pk)]).toString('base64'),
        'base64',
      ],
      owner: ALT,
      executable: false,
      rentEpoch: 0,
      space: 56 + 32 * tableKeys.length,
    },
  }),
);
async function keyFile(name, key) {
  const path = join(scratch, name + '.json');
  await writeFile(path, JSON.stringify([...key.secretKey, ...key.publicKey]), {
    mode: 0o600,
  });
  return path;
}
const homeFile = await keyFile('home', home),
  quoteFile = await keyFile('quote-mint', quoteMint),
  assetFile = await keyFile('asset-mint', assetMint);
let validator;
const summary = {
  cluster: 'localnet',
  realFunds: false,
  checks: [],
  swapBytes: [],
};
const check = (name) => {
  summary.checks.push(name);
  console.log('PASS ' + name);
};
async function rpc(method, params = []) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const b = await r.json();
  if (b.error) throw Error(JSON.stringify(b.error));
  return b.result;
}
async function send(ixs, payer = home, useTable = false) {
  const block = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]))
    .value;
  const message = compileGuardMessage({
    payer: payer.address,
    instructions: ixs,
    recentBlockhash: block.blockhash,
    ...(useTable ? { tables: [{ address: table, addresses: tableKeys }] } : {}),
  });
  const tx = signCompiledMessage(message, [payer]);
  const signature = await rpc('sendTransaction', [
    tx.base64,
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  for (let i = 0; i < 300; i++) {
    const s = (await rpc('getSignatureStatuses', [[signature]])).value[0];
    if (s?.err) throw Error(JSON.stringify(s.err));
    if (s && ['confirmed', 'finalized'].includes(s.confirmationStatus))
      return tx;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(
    'Local transaction timed out: ' +
      JSON.stringify(
        await rpc('simulateTransaction', [
          tx.base64,
          { encoding: 'base64', sigVerify: true, commitment: 'confirmed' },
        ]),
      ),
  );
}
async function rejected(ixs, pattern = /.*/, payer = home, useTable = false) {
  await assert.rejects(send(ixs, payer, useTable), pattern);
}
// The browser/API prepares unsigned wire bytes; only this isolated rehearsal
// signs with a disposable key and submits to its own loopback validator.
async function sendPrepared(action) {
  const reader = createGuardChainReader({
    CONCLAVE_GUARD_LOCAL_ENABLED: 'true',
    CONCLAVE_GUARD_LOCAL_RPC_URL: endpoint,
  });
  const prepared = await reader.prepare(home.address, action);
  assert.equal(prepared.unsigned, true);
  assert.equal(prepared.broadcast, false);
  const wire = Buffer.from(prepared.transactionBase64, 'base64');
  assert.equal(wire[0], 1);
  assert.ok(wire.subarray(1, 65).equals(Buffer.alloc(64)));
  wire.set(ed25519.sign(wire.subarray(65), home.secretKey), 1);
  const signature = await rpc('sendTransaction', [
    wire.toString('base64'),
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  for (let i = 0; i < 300; i++) {
    const s = (await rpc('getSignatureStatuses', [[signature]])).value[0];
    if (s?.err) throw Error(JSON.stringify(s.err));
    if (s && ['confirmed', 'finalized'].includes(s.confirmationStatus))
      return reader.state(home.address);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Local prepared transaction timed out');
}
async function spl(args) {
  const { stdout } = await run(
    'spl-token',
    [...args, '--url', endpoint, '--output', 'json'],
    { timeout: 30000, maxBuffer: 1000000 },
  );
  return JSON.parse(stdout);
}
const balance = async (address) =>
  BigInt(
    (
      await rpc('getTokenAccountBalance', [
        address,
        { commitment: 'confirmed' },
      ])
    ).value.amount,
  );
const positionState = async () => {
  const data = Buffer.from(
    (
      await rpc('getAccountInfo', [
        position,
        { encoding: 'base64', commitment: 'confirmed' },
      ])
    ).value.data[0],
    'base64',
  );
  return { quantity: data.readBigUInt64LE(72), cost: data.readBigUInt64LE(80) };
};
try {
  const log = await open(join(scratch, 'validator.log'), 'w');
  validator = spawn(
    'solana-test-validator',
    [
      '--quiet',
      '--ledger',
      join(scratch, 'ledger'),
      '--bind-address',
      '127.0.0.1',
      '--rpc-port',
      String(base),
      '--faucet-port',
      String(base + 2),
      '--gossip-port',
      String(base + 3),
      '--dynamic-port-range',
      `${base + 5}-${base + 35}`,
      '--faucet-sol',
      '1000',
      '--upgradeable-program',
      GUARD,
      resolve('../programs/target/deploy/cncl_guard.so'),
      home.address,
      '--bpf-program',
      ANCHOR,
      resolve('../programs/target/deploy/cncl_anchor.so'),
      '--bpf-program',
      JUP,
      resolve(
        '../programs/tests/router-fixture/target/deploy/router_fixture.so',
      ),
      '--account',
      table,
      tableFile,
    ],
    { stdio: ['ignore', log.fd, log.fd] },
  );
  await log.close();
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try {
      healthy = (await rpc('getHealth')) === 'ok';
      if (healthy) break;
    } catch {}
    if (validator.exitCode !== null)
      throw Error(
        'Validator exited: ' +
          (await readFile(join(scratch, 'validator.log'), 'utf8')),
      );
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(healthy, 'Local validator became healthy');
  for (const key of [home, outsider])
    await run(
      'solana',
      [
        'airdrop',
        '20',
        key.address,
        '--url',
        endpoint,
        '--commitment',
        'confirmed',
      ],
      { timeout: 30000 },
    );
  for (const file of [quoteFile, assetFile])
    await spl([
      'create-token',
      file,
      '--decimals',
      '6',
      '--fee-payer',
      homeFile,
      '--mint-authority',
      home.address,
    ]);
  for (const mint of [quoteMint.address, assetMint.address])
    for (const owner of [home.address, vault, pool])
      await spl([
        'create-account',
        mint,
        '--owner',
        owner,
        '--fee-payer',
        homeFile,
      ]);
  for (const [mint, amount, destination] of [
    [quoteMint.address, '400', vaultQuote],
    [quoteMint.address, '10000', poolQuote],
    [assetMint.address, '10000', poolAsset],
  ])
    await spl([
      'mint',
      mint,
      amount,
      destination,
      '--mint-authority',
      homeFile,
      '--fee-payer',
      homeFile,
    ]);
  const initAccounts = [
    meta(home.address, true, true),
    meta(GUARD),
    meta(programData),
    meta(config, true),
    meta(quoteMint.address),
    meta(SYS),
  ];
  const initArgs = [
    home.publicKey,
    domain,
    ...quotes.map((k) => k.publicKey),
    zero,
    zero,
    zero,
    cosigner.publicKey,
    zero,
    zero,
    zero,
  ];
  await rejected(
    [
      instruction(
        GUARD,
        'initialize_config',
        [meta(outsider.address, true, true), ...initAccounts.slice(1)],
        ...initArgs,
      ),
    ],
    /Unauthorized|6000|Constraint/,
    outsider,
  );
  await send([
    instruction(GUARD, 'initialize_config', initAccounts, ...initArgs),
  ]);
  check('Only the program upgrade authority can initialize configuration');
  const opened = await sendPrepared({
    kind: 'open',
    strict: true,
    timezoneMinutes: 0,
    limits: {
      dailyBuy: '100000000',
      perToken: '50000000',
      dailyLoss: '25000000',
      slippageBps: 100,
      cooldownLosses: 3,
      cooldownSeconds: 600,
    },
  });
  assert.equal(opened.vault.address, vault);
  assert.equal(opened.vault.strict, true);
  assert.equal(opened.vault.limits.dailyBuy, '100000000');
  check(
    'Web adapter decodes the real program state and prepares an executable unsigned vault action',
  );
  await send([
    instruction(GUARD, 'create_position', [
      meta(home.address, true, true),
      meta(vault),
      meta(assetMint.address),
      meta(position, true),
      meta(SYS),
    ]),
  ]);
  const manage = (name, ...args) =>
    instruction(
      GUARD,
      name,
      [meta(home.address, false, true), meta(vault, true)],
      ...args,
    );
  await rejected(
    [
      instruction(GUARD, 'pause', [
        meta(outsider.address, false, true),
        meta(vault, true),
      ]),
    ],
    /Unauthorized|6000/,
    outsider,
  );
  await send([
    manage(
      'propose_change',
      Buffer.from([1]),
      limits(200000000n),
      zero,
      u16(0),
    ),
  ]);
  await rejected([manage('apply_change')], /Timelock|6003/);
  check('Outsiders cannot manage the vault and loosening has a 24-hour lock');
  await run(
    'solana',
    [
      'transfer',
      gas,
      '0.05',
      '--allow-unfunded-recipient',
      '--from',
      homeFile,
      '--fee-payer',
      homeFile,
      '--url',
      endpoint,
      '--commitment',
      'confirmed',
    ],
    { timeout: 30000 },
  );
  const gasBalance = async () =>
    BigInt((await rpc('getBalance', [gas, { commitment: 'confirmed' }])).value);
  const gasRefund = () =>
    instruction(GUARD, 'reimburse_gas', [
      meta(home.address, true, true),
      meta(vault, true),
      meta(config),
      meta(gas, true),
      meta(vaultQuote),
      meta(IX),
      meta(SYS),
    ]);
  await rejected([gasRefund()], /GasUnavailable/);
  let nonce = 0n,
    cosignNonce = 0n;
  async function swap({
    buy = true,
    amount = 10000000n,
    out = 20000000n,
    mode = 0,
    min = out,
    duplicate = false,
    stale = false,
    strict = true,
    reimburse = false,
  } = {}) {
    const slot = BigInt(await rpc('getSlot', [{ commitment: 'confirmed' }]));
    const q = {
      side: buy ? 0 : 1,
      inputMint: buy ? quoteMint.address : assetMint.address,
      outputMint: buy ? assetMint.address : quoteMint.address,
      amount,
      quotedNet: min,
      expiresSlot: stale ? 0n : slot + 100n,
      nonce: ++nonce,
    };
    const digest = guardQuoteDigest(vault, domain, q),
      signers = duplicate ? [quotes[0], quotes[0]] : quotes;
    const ixs = signers.map((k) =>
      ed25519Attestation(
        k.publicKey,
        ed25519.sign(digest, k.secretKey),
        digest,
      ),
    );
    if (buy && strict) {
      const d = guardCosignDigest(
        vault,
        domain,
        assetMint.address,
        amount,
        cosignNonce + 1n,
        q.expiresSlot,
      );
      ixs.push(
        ed25519Attestation(
          cosigner.publicKey,
          ed25519.sign(d, cosigner.secretKey),
          d,
        ),
      );
    }
    const routed = buy ? amount - (amount * 50n) / 10000n : amount;
    const route = Buffer.concat([
      disc('route'),
      vec(Buffer.from([mode])),
      u64(routed),
      u64(out),
      u16(100),
      Buffer.from([0]),
    ]);
    const source = buy ? vaultQuote : vaultAsset,
      destination = buy ? vaultAsset : vaultQuote;
    const fixed = [
      meta(home.address, false, true),
      meta(vault, true),
      meta(config),
      meta(quoteMint.address),
      meta(assetMint.address),
      meta(vaultQuote, true),
      meta(vaultAsset, true),
      meta(position, true),
      meta(feeAccount, true),
      meta(TOKEN),
      meta(TOKEN),
      meta(JUP),
      meta(IX),
    ];
    const routeAccounts = [
      meta(TOKEN),
      meta(vault),
      meta(source, true),
      meta(destination, true),
      meta(JUP),
      meta(q.outputMint),
      meta(JUP),
      meta(JUP),
      meta(JUP),
      meta(buy ? poolQuote : poolAsset, true),
      meta(buy ? poolAsset : poolQuote, true),
      meta(pool),
    ];
    ixs.push(
      instruction(
        GUARD,
        'swap',
        [...fixed, ...routeAccounts],
        encodeGuardQuote(q),
        u64(min),
        Buffer.from([0]),
        vec(route),
      ),
    );
    if (reimburse) {
      const compute = 'ComputeBudget111111111111111111111111111111';
      ixs.unshift(
        {
          programId: compute,
          accounts: [],
          data: Buffer.concat([Buffer.from([2]), u32(500000)]),
        },
        {
          programId: compute,
          accounts: [],
          data: Buffer.concat([Buffer.from([3]), u64(4000n)]),
        },
      );
      ixs.push(gasRefund());
    }
    const tx = await send(ixs, home, true);
    summary.swapBytes.push(tx.byteLength);
    if (buy) cosignNonce++;
    return tx;
  }
  await assert.rejects(swap({ duplicate: true }), /AttestationRequired|6007/);
  await assert.rejects(swap({ strict: false }), /AttestationRequired|6007/);
  await assert.rejects(swap({ stale: true }), /StaleQuote|6008/);
  check(
    'Two distinct quote signers, strict cosigner and fresh slots are enforced',
  );
  const before = await balance(vaultQuote);
  for (const mode of [1, 2, 3]) {
    await assert.rejects(swap({ mode }));
    assert.equal(await balance(vaultQuote), before);
    assert.equal(await balance(vaultAsset), 0n);
  }
  check(
    'Over-spend, insufficient output and persistent delegate attacks roll back atomically',
  );
  const gasBefore = await gasBalance();
  const bought = await swap({ reimburse: true });
  const receipt = await rpc('getTransaction', [
    bought.signature,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]);
  assert.equal(gasBefore - (await gasBalance()), BigInt(receipt.meta.fee));
  await rejected([gasRefund()], /GasUnavailable/);
  check('Gas reimbursement equals the landed fee and cannot be claimed again');
  assert.equal(await balance(vaultQuote), 390000000n);
  assert.equal(await balance(vaultAsset), 20000000n);
  assert.equal(await balance(feeAccount), 50000n);
  assert.deepEqual(await positionState(), {
    quantity: 20000000n,
    cost: 10000000n,
  });
  check(
    'Strict buy executes through nested token CPI with exact fee and tracked basis',
  );
  await send([manage('pause')]);
  await assert.rejects(swap(), /BuyBlocked|6009/);
  await swap({ buy: false, amount: 10000000n, out: 6000000n, min: 5970000n });
  assert.equal(await balance(vaultAsset), 10000000n);
  assert.equal(await balance(vaultQuote), 395970000n);
  assert.deepEqual(await positionState(), {
    quantity: 10000000n,
    cost: 5000000n,
  });
  check('Pause blocks new buys while an attested exit still works');
  for (const signer of quotes)
    await send([
      instruction(
        GUARD,
        'remove_key',
        [meta(home.address, false, true), meta(config, true)],
        Buffer.from([1]),
        signer.publicKey,
      ),
    ]);
  await sendPrepared({
    kind: 'withdraw_home',
    mint: assetMint.address,
    amount: '10000000',
  });
  const withdrawn = await sendPrepared({
    kind: 'withdraw_home',
    mint: quoteMint.address,
    amount: '395970000',
  });
  assert.equal(withdrawn.quoteBalance, '0');
  assert.equal(withdrawn.vault.openCostUsd6, '0');
  assert.equal(withdrawn.vault.paused, true);
  assert.equal(await balance(vaultQuote), 0n);
  assert.equal(await balance(homeAsset), 10000000n);
  check(
    'Home can withdraw all assets while paused and every quote signer is removed',
  );
  const namespace = randomBytes(32),
    room = pda(ANCHOR, seed('room'), home.publicKey, namespace),
    day = BigInt(Math.floor(Date.now() / 86400000) - 1),
    checkpoint = pda(ANCHOR, seed('day'), pk(room), u64(day)),
    root = randomBytes(32);
  await send([
    instruction(
      ANCHOR,
      'create_room',
      [meta(home.address, true, true), meta(room, true), meta(SYS)],
      namespace,
    ),
  ]);
  const publish = instruction(
    ANCHOR,
    'publish_day',
    [
      meta(home.address, true, true),
      meta(room, true),
      meta(checkpoint, true),
      meta(SYS),
    ],
    u64(day),
    u64(9n),
    zero,
    root,
  );
  await send([publish]);
  await rejected([publish]);
  check('Daily room commitment is immutable in the local runtime');
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error);
  console.error(
    (
      await readFile(join(scratch, 'ledger', 'validator.log'), 'utf8').catch(
        () => '',
      )
    ).slice(-5000),
  );
  process.exitCode = 1;
} finally {
  if (
    validator &&
    validator.exitCode === null &&
    validator.signalCode === null
  ) {
    validator.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => validator.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (validator.exitCode === null && validator.signalCode === null) {
      validator.kill('SIGKILL');
      await new Promise((r) => validator.once('exit', r));
    }
  }
  await rm(scratch, { recursive: true, force: true });
}
