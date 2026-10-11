import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { createDatabase, transaction } from '../server/db/database.ts';
import { splitPlatformFee } from '../server/ledger/platform-fee.ts';
import { platformTokenConfig } from '../server/token/config.ts';
import { createTokenRpc } from '../server/token/localnet-rpc.ts';
import { createSimulatedJupiter } from '../server/token/buyback.ts';
import { executeBurn } from '../server/token/burn.ts';
import { listTokenBurns, verifyTokenBurnRecord } from '../server/token/burn-ledger.ts';
import { createSimulatedPriceSource } from '../server/token/price.ts';
import { generateKeypair, loadLocalKeypair } from '../server/token/transaction-builder.ts';
import { migrate } from './migrate.mjs';
import { databaseIdentifier, testEndpoint } from './check-database.mjs';

// End-to-end burn rehearsal on a throwaway local validator. Not part of the
// test suite. It proves that the executor, the simulated buyback and the
// ledger agree with the chain for a test mint on localnet: supply falls by
// exactly the recorded burn, and the database row matches both. It proves
// nothing about a real token, a market or mainnet.
//
// Requirements: solana-test-validator, spl-token and solana on PATH;
// CONCLAVE_TEST_DATABASE_URL naming a loopback PostgreSQL database ending in
// _test (a fresh conclave_<hex>_test database is created beside it and dropped
// afterwards). Optional: CONCLAVE_REHEARSAL_DIR for the ledger and keypair
// scratch directory (default: a temporary directory). Everything created here
// is removed on exit, including the validator ledger and the keypair files.

const run = promisify(execFile);
const HOUR = 3_600_000;
const PRICE_USD6_PER_TOKEN = 1_000n;

function log(message) {
  process.stderr.write(`${message}\n`);
}

async function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Never 8899 when busy: scan from 8999 for a block of free ports. */
async function pickPorts() {
  for (let base = 8999; base < 9999; base += 50) {
    // The validator insists on at least 25 dynamic ports.
    const needed = [base, base + 1, base + 2, ...Array.from({ length: 30 }, (_, i) => base + 5 + i)];
    const states = await Promise.all(needed.map(portFree));
    if (states.every(Boolean))
      return { rpc: base, faucet: base + 1, gossip: base + 2, dynamic: `${base + 5}-${base + 34}` };
  }
  throw new Error('No free port block for the test validator.');
}

async function waitForHealth(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }),
      });
      const body = await response.json();
      if (body.result === 'ok') return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('The test validator did not become healthy in time.');
}

/** Retries a finalized-commitment read until the setup transactions have finalized. */
async function untilFinalized(read, ready, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (ready(value)) return value;
      last = new Error('The finalized state does not match yet.');
    } catch (error) {
      if (error?.code !== 'TOKEN_RPC_REJECTED') throw error;
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw last ?? new Error('Finalization timed out.');
}

async function writeKeypair(directory, name, keypair) {
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify([...keypair.secretKey, ...keypair.publicKey]), { mode: 0o600 });
  return path;
}

async function splToken(url, args) {
  const { stdout } = await run('spl-token', [...args, '--url', url, '--output', 'json'], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function airdrop(url, address, sol) {
  await run('solana', ['airdrop', String(sol), address, '--url', url, '--commitment', 'finalized'], {
    timeout: 120_000,
  });
}

/** Three backdated accruals through the 019 settlement shape (see check-token-ledger.mjs). */
async function seedAccruals(pool, periodEnd) {
  const accountId = randomUUID(), projectId = randomUUID(), routeVersionId = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query("INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Rehearsal fixture')", [projectId, accountId]);
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
    VALUES($1,$2,1,'fixture','fixture','chat',true,'{}','{}',now()+interval '1 hour')`,
    [routeVersionId, randomUUID()],
  );
  for (const kind of ['revenue', 'clearing'])
    await pool.query(
      'INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,NULL,$2) ON CONFLICT (owner_id,kind) DO NOTHING',
      [randomUUID(), kind],
    );
  const accounts = Object.fromEntries(
    (await pool.query("SELECT kind,id FROM ledger_accounts WHERE owner_id IS NULL AND kind IN ('revenue','burn_reserve')")).rows
      .map((row) => [row.kind, row.id]),
  );
  let total = 0n;
  for (const [base, minutesBeforeEnd] of [[1234, 150], [1000, 90], [200, 30]]) {
    const split = splitPlatformFee(BigInt(base), 500, 5000);
    const createdAt = new Date(periodEnd.getTime() - minutesBeforeEnd * 60_000);
    const quoteId = randomUUID(), holdId = randomUUID(), transactionId = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
        VALUES($1,$2,$3,$4,'fixture-hash',1501,128,now()+interval '2 minutes')`,
        [quoteId, accountId, projectId, routeVersionId],
      );
      await client.query(
        'INSERT INTO quote_platform_fees(quote_id,base_maximum_usd6,platform_fee_bps,burn_share_bps,platform_fee_maximum_usd6) VALUES($1,1430,500,5000,71)',
        [quoteId],
      );
      await client.query(
        `INSERT INTO holds(id,account_id,quote_id,idempotency_key,request_hash,maximum_usd6,captured_usd6,state)
        VALUES($1,$2,$3,$4,'fixture-hash',1501,$5,'captured')`,
        [holdId, accountId, quoteId, randomUUID(), split.totalUsd6.toString()],
      );
      await client.query('INSERT INTO ledger_transactions(id,reference,kind,created_at) VALUES($1,$2,$3,$4)', [
        transactionId, `burn-accrual:${holdId}`, 'burn_accrual', createdAt,
      ]);
      for (const [account, amount] of [[accounts.revenue, -split.burnReserveUsd6], [accounts.burn_reserve, split.burnReserveUsd6]])
        await client.query(
          'INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6,created_at) VALUES($1,$2,$3,$4)',
          [transactionId, account, amount.toString(), createdAt],
        );
      await client.query(
        `INSERT INTO hold_platform_fees(hold_id,quote_id,base_usd6,platform_fee_usd6,burn_reserve_usd6,ledger_transaction_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [holdId, quoteId, split.baseUsd6.toString(), split.platformFeeUsd6.toString(), split.burnReserveUsd6.toString(), transactionId, createdAt],
      );
    });
    total += split.burnReserveUsd6;
  }
  return total;
}

async function reserveBalances(pool) {
  const rows = (await pool.query("SELECT kind,balance_usd6::text FROM ledger_accounts WHERE owner_id IS NULL AND kind IN ('burn_reserve','burn_executed')")).rows;
  return Object.fromEntries(rows.map((row) => [row.kind, row.balance_usd6]));
}

async function main() {
  const endpoint = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL);
  const scratch = process.env.CONCLAVE_REHEARSAL_DIR
    ? await mkdtemp(join(process.env.CONCLAVE_REHEARSAL_DIR, 'burn-rehearsal-'))
    : await mkdtemp(join(tmpdir(), 'conclave-burn-rehearsal-'));
  const ledgerDirectory = join(scratch, 'ledger');
  const ports = await pickPorts();
  const url = `http://127.0.0.1:${ports.rpc}`;
  const databaseName = `conclave_${randomUUID().replaceAll('-', '')}_test`;
  // The named database is only a maintenance connection; the rehearsal never
  // writes to it. When it does not exist, fall back to the server's postgres db.
  const adminClient = (database) =>
    new pg.Client({
      host: endpoint.hostname.replace(/^\[|\]$/g, ''),
      port: endpoint.port ? Number(endpoint.port) : 5432,
      database,
      user: decodeURIComponent(endpoint.username),
      password: decodeURIComponent(endpoint.password),
      ssl: endpoint.searchParams.has('sslmode') ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 5_000,
    });
  let admin = adminClient(decodeURIComponent(endpoint.pathname.slice(1)));
  let validator, pool, created = false;
  const summary = { cluster: 'localnet', rpcPort: ports.rpc, program: 'token-2022', decimals: 6 };
  try {
    log(`Starting solana-test-validator on port ${ports.rpc} (ledger under a scratch directory)...`);
    const validatorLog = await open(join(scratch, 'validator.log'), 'w');
    validator = spawn(
      'solana-test-validator',
      [
        '--reset', '--quiet', '--ledger', ledgerDirectory, '--bind-address', '127.0.0.1',
        '--rpc-port', String(ports.rpc), '--faucet-port', String(ports.faucet), '--gossip-port', String(ports.gossip),
        '--dynamic-port-range', ports.dynamic, '--faucet-sol', '1000',
      ],
      { stdio: ['ignore', validatorLog.fd, validatorLog.fd] },
    );
    await validatorLog.close();
    const exited = new Promise((resolve) => validator.once('exit', resolve));
    let healthy = false;
    await Promise.race([
      waitForHealth(url).then(() => {
        healthy = true;
      }),
      exited.then(async (code) => {
        if (healthy) return;
        const tail = await readFile(join(scratch, 'validator.log'), 'utf8').catch(() => '');
        log(tail.split('\n').slice(-5).join('\n'));
        throw new Error(`The test validator exited early (code ${code}).`);
      }),
    ]);
    log('Validator healthy. Creating throwaway keypairs and funding them...');

    const burnWallet = generateKeypair();
    const maker = generateKeypair();
    const burnKeypairFile = await writeKeypair(scratch, 'burn-wallet', burnWallet);
    const makerKeypairFile = await writeKeypair(scratch, 'maker', maker);
    await airdrop(url, maker.address, 10);
    await airdrop(url, burnWallet.address, 2);

    log('Creating a test token-2022 mint (6 decimals) and token accounts...');
    const createdMint = await splToken(url, [
      'create-token', '--program-2022', '--decimals', '6', '--fee-payer', makerKeypairFile, '--mint-authority', maker.address,
    ]);
    const mint = createdMint.commandOutput?.address ?? createdMint.address;
    assert.match(String(mint), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'spl-token create-token output');
    // create-account only echoes a signature; the associated address is derived separately.
    const associated = async (owner) => {
      await splToken(url, ['create-account', mint, '--owner', owner, '--fee-payer', makerKeypairFile]);
      const shown = await splToken(url, ['address', '--verbose', '--owner', owner, '--token', mint, '--program-2022']);
      const account = shown.associatedTokenAddress ?? shown.commandOutput?.associatedTokenAddress ?? shown.address;
      assert.match(String(account), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, `spl-token address output keys: ${Object.keys(shown).join(',')}`);
      return account;
    };
    const makerAccount = await associated(maker.address);
    const burnAccount = await associated(burnWallet.address);
    assert.notEqual(makerAccount, burnAccount);
    await splToken(url, ['mint', mint, '1000000', makerAccount, '--mint-authority', makerKeypairFile, '--fee-payer', makerKeypairFile]);
    Object.assign(summary, { mint, makerTokenAccount: makerAccount, burnTokenAccount: burnAccount });

    // Token configuration for this run only.
    Object.assign(process.env, {
      CONCLAVE_TOKEN_MINT: mint,
      CONCLAVE_TOKEN_CLUSTER: 'localnet',
      CONCLAVE_TOKEN_RPC_URL: url,
      CONCLAVE_TOKEN_DECIMALS: '6',
      CONCLAVE_TOKEN_PROGRAM: 'token-2022',
      CONCLAVE_TOKEN_BURN_ENABLED: 'true',
      CONCLAVE_TOKEN_BURN_KEYPAIR_FILE: burnKeypairFile,
    });
    const config = platformTokenConfig();
    assert.equal(config.configured, true);
    const rpc = createTokenRpc({ config, finalizationTimeoutMs: 180_000 });
    const keypair = loadLocalKeypair(process.env.CONCLAVE_TOKEN_BURN_KEYPAIR_FILE, config);
    assert.equal(keypair.address, burnWallet.address);
    // spl-token returns at confirmed commitment; the client reads at finalized.
    const supplyBefore = await untilFinalized(() => rpc.getTokenSupply(mint), (supply) => supply.amountRaw === 1_000_000_000_000n);
    await untilFinalized(() => rpc.getTokenAccountBalance(makerAccount), (held) => held.amountRaw === 1_000_000_000_000n);
    await untilFinalized(() => rpc.getTokenAccountBalance(burnAccount), (held) => held.amountRaw === 0n);

    log('Creating a throwaway database, migrating and seeding reserve accruals...');
    try {
      await admin.connect();
    } catch (error) {
      if (error?.code !== '3D000') throw error;
      admin = adminClient('postgres');
      await admin.connect();
    }
    await admin.query(`CREATE DATABASE ${databaseIdentifier(databaseName)} TEMPLATE template0`);
    created = true;
    const connection = new URL(endpoint);
    connection.pathname = `/${databaseName}`;
    pool = createDatabase(connection.href, 4);
    await migrate(pool);
    const periodEnd = new Date(Math.floor(Date.now() / HOUR) * HOUR);
    const accrued = await seedAccruals(pool, periodEnd);
    const before = await reserveBalances(pool);
    assert.equal(before.burn_reserve, accrued.toString());

    log('Executing the burn: simulated buyback (TransferChecked from the maker), then BurnChecked...');
    const result = await executeBurn({
      pool,
      config,
      rpc,
      priceSource: createSimulatedPriceSource({ priceUsd6PerToken: PRICE_USD6_PER_TOKEN }),
      keypair,
      burnTokenAccount: burnAccount,
      periodEnd,
      funding: 'buyback-simulation',
      buyback: createSimulatedJupiter({ rpc, config, makerKeypair: maker, makerTokenAccount: makerAccount, burnTokenAccount: burnAccount }),
    });

    log('Verifying chain and ledger agree...');
    const supplyAfter = await rpc.getTokenSupply(mint);
    const burned = BigInt(result.tokensBurnedRaw);
    assert.equal(supplyBefore.amountRaw - supplyAfter.amountRaw, burned, 'supply must fall by exactly the burned amount');
    assert.equal((await rpc.getTokenAccountBalance(burnAccount)).amountRaw, 0n, 'the burn wallet burns everything it bought');
    assert.equal((await rpc.getTokenAccountBalance(makerAccount)).amountRaw, 1_000_000_000_000n - burned);
    const [record] = await listTokenBurns(pool, { limit: 1 });
    assert.equal(record.id, result.id);
    assert.equal(record.tokensBurnedRaw, result.tokensBurnedRaw);
    assert.equal(record.burnSignature, result.burnSignature);
    assert.equal(record.swapSignature, result.swapSignature);
    assert.equal(record.spentUsd6, accrued.toString());
    assert.ok(verifyTokenBurnRecord(record));
    const after = await reserveBalances(pool);
    assert.equal(after.burn_reserve, '0');
    assert.equal(after.burn_executed, accrued.toString());
    const [burnStatus] = await rpc.getSignatureStatuses([result.burnSignature]);
    assert.equal(burnStatus.state, 'finalized');
    Object.assign(summary, {
      period: { start: result.periodStart, end: result.periodEnd },
      ledger: { accruedUsd6: accrued.toString(), reserveBefore: before.burn_reserve, reserveAfter: after.burn_reserve, executedUsd6: after.burn_executed },
      priceUsd6PerToken: result.priceUsd6PerToken,
      tokensBoughtRaw: result.tokensBoughtRaw,
      tokensBurnedRaw: result.tokensBurnedRaw,
      supplyBeforeRaw: supplyBefore.amountRaw.toString(),
      supplyAfterRaw: supplyAfter.amountRaw.toString(),
      swapSignature: result.swapSignature,
      burnSignature: result.burnSignature,
      finalizedSlot: result.finalizedSlot,
      recordHash: result.recordHash,
      verified: true,
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    log('Cleaning up: stopping the validator, dropping the database, removing scratch files...');
    if (pool) await pool.end().catch(() => {});
    if (created) await admin.query(`DROP DATABASE ${databaseIdentifier(databaseName)}`).catch(() => log('Database cleanup failed; drop it manually.'));
    await admin.end().catch(() => {});
    if (validator && validator.exitCode === null) {
      const exited = new Promise((resolve) => validator.once('exit', resolve));
      validator.kill('SIGTERM');
      const timer = setTimeout(() => validator.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  log(`Rehearsal failed: ${error instanceof Error ? `${error.name}: ${error.message}${error.code ? ` (${error.code})` : ''}` : String(error)}`);
  process.exitCode = 1;
});
