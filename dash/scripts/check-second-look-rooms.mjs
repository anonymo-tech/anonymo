import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  linkWallet,
  unlinkWallet,
} from '../server/second-look/wallet-store.ts';
import {
  roomProofChallenge,
  completeRoomProof,
} from '../server/second-look/room-proofs.ts';
import {
  createRoom,
  listRooms,
  inviteRoom,
  joinRoom,
  roomMembers,
  changeRoomMember,
  purchaseRoomSeats,
  captureRoomCall,
  roomHistory,
  roomHash,
} from '../server/second-look/rooms-store.ts';
import { creditVerifiedDeposit, getBalance } from '../server/ledger/ledger.ts';
import { roomsRoutes } from '../server/second-look/rooms-routes.ts';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
const url = new URL(connection ?? 'https://invalid.test');
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw Error('An isolated loopback *_test database is required.');
for (const key of Object.keys(process.env))
  if (key.startsWith('CONCLAVE_')) delete process.env[key];
process.env.CONCLAVE_ACTIVE_DATA_KEY = 'rooms-test';
process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
  'rooms-test': randomBytes(32).toString('base64'),
});
const pool = createDatabase(connection, 8),
  mint = 'So11111111111111111111111111111111111111112';
const origin = 'https://workspace.example.test';
const code = (expected) => (e) => e.code === expected;
before(() => migrate(pool));
after(() => pool.end());
async function user() {
  const id = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  return id;
}
async function wallet(accountId) {
  const secret = randomBytes(32),
    address = bs58.encode(ed25519.getPublicKey(secret)),
    linked = await linkWallet(pool, accountId, address, 'Room caller');
  return { ...linked, secret };
}
async function prove(accountId, w) {
  const session = { accountId, tokenHash: roomHash(randomUUID()) },
    challenge = await roomProofChallenge(pool, session, w.id, origin);
  const signature = Buffer.from(
    ed25519.sign(new TextEncoder().encode(challenge.message), w.secret),
  ).toString('base64');
  await completeRoomProof(pool, session, challenge.id, signature);
  return { session, challenge, signature };
}
test('session-bound ownership proof rejects forgery, wrong account, replay and stale challenge', async () => {
  const a = await user(),
    b = await user(),
    w = await wallet(a),
    session = { accountId: a, tokenHash: roomHash('session') };
  await assert.rejects(
    roomProofChallenge(pool, { ...session, accountId: b }, w.id, origin),
  );
  const c = await roomProofChallenge(pool, session, w.id, origin),
    sig = Buffer.from(
      ed25519.sign(new TextEncoder().encode(c.message), w.secret),
    ).toString('base64');
  await assert.rejects(
    completeRoomProof(
      pool,
      { ...session, tokenHash: roomHash('other') },
      c.id,
      sig,
    ),
    code('PROOF_EXPIRED'),
  );
  await assert.rejects(
    completeRoomProof(pool, session, c.id, Buffer.alloc(64).toString('base64')),
    code('INVALID_PROOF'),
  );
  assert.equal(
    (await completeRoomProof(pool, session, c.id, sig)).ownership,
    'wallet_signature',
  );
  await assert.rejects(
    completeRoomProof(pool, session, c.id, sig),
    code('PROOF_EXPIRED'),
  );
  const stale = await roomProofChallenge(pool, session, w.id, origin);
  await pool.query(
    "UPDATE second_look_room_proof_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
    [stale.id],
  );
  await assert.rejects(
    completeRoomProof(pool, session, stale.id, sig),
    code('PROOF_EXPIRED'),
  );
  await unlinkWallet(pool, a, w.id);
  assert.equal(
    (
      await pool.query(
        'SELECT * FROM second_look_room_wallet_proofs WHERE wallet_id=$1',
        [w.id],
      )
    ).rowCount,
    0,
  );
});
test('rooms hide outsiders, enforce roles, revoke membership and consume invitations once', async () => {
  const a = await user(),
    b = await user(),
    c = await user(),
    room = await createRoom(pool, a, 'Private research');
  assert.equal((await listRooms(pool, b)).rooms.length, 0);
  await assert.rejects(roomHistory(pool, b, room.id), code('ROOM_UNAVAILABLE'));
  const invite = await inviteRoom(pool, a, room.id, 'viewer');
  const joined = await joinRoom(pool, b, invite.token);
  assert.equal(joined.role, 'viewer');
  await assert.rejects(
    joinRoom(pool, c, invite.token),
    code('INVITE_UNAVAILABLE'),
  );
  await assert.rejects(
    inviteRoom(pool, b, room.id, 'caller'),
    code('ROOM_OWNER_REQUIRED'),
  );
  await assert.rejects(
    captureRoomCall(pool, b, room.id, {
      walletId: randomUUID(),
      mint,
      note: '',
      key: randomUUID(),
    }),
    code('CALLER_REQUIRED'),
  );
  await changeRoomMember(pool, a, room.id, b, 'caller');
  assert.equal((await roomMembers(pool, b, room.id)).members.length, 2);
  await changeRoomMember(pool, a, room.id, b, null);
  await assert.rejects(roomMembers(pool, b, room.id), code('ROOM_UNAVAILABLE'));
  await assert.rejects(
    changeRoomMember(pool, a, room.id, a, null),
    code('OWNER_MEMBERSHIP_REQUIRED'),
  );
  const raw = (
    await pool.query(
      'SELECT name_ciphertext FROM second_look_rooms WHERE id=$1',
      [room.id],
    )
  ).rows[0].name_ciphertext;
  assert.ok(!raw.includes('Private research'));
});
test('competing invitation redemptions cannot overfill the last seat', async () => {
  const owner = await user(),
    room = await createRoom(pool, owner, 'Seats');
  for (let i = 0; i < 8; i++) {
    const invite = await inviteRoom(pool, owner, room.id, 'viewer');
    await joinRoom(pool, await user(), invite.token);
  }
  const x = await inviteRoom(pool, owner, room.id, 'caller'),
    y = await inviteRoom(pool, owner, room.id, 'caller');
  const results = await Promise.allSettled([
    joinRoom(pool, await user(), x.token),
    joinRoom(pool, await user(), y.token),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await roomMembers(pool, owner, room.id)).members.length, 10);
});
test('captured calls require proof, preserve first capture, serialize and verify the entire chain', async () => {
  const a = await user(),
    room = await createRoom(pool, a, 'Captures'),
    w = await wallet(a),
    input = { walletId: w.id, mint, note: 'First capture', key: randomUUID() };
  await assert.rejects(
    captureRoomCall(pool, a, room.id, input),
    code('WALLET_PROOF_REQUIRED'),
  );
  await prove(a, w);
  const first = await captureRoomCall(pool, a, room.id, input);
  assert.equal(first.evidence.priceUsd6, null);
  assert.equal(first.ownership, 'wallet_signature');
  assert.equal(
    (await captureRoomCall(pool, a, room.id, input)).hash,
    first.hash,
  );
  await assert.rejects(
    captureRoomCall(pool, a, room.id, {
      ...input,
      note: 'Edited after capture',
    }),
    code('CALL_KEY_CONFLICT'),
  );
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      captureRoomCall(pool, a, room.id, {
        ...input,
        note: 'Call ' + i,
        key: randomUUID(),
      }),
    ),
  );
  const history = await roomHistory(pool, a, room.id);
  assert.equal(history.calls.length, 9);
  assert.equal(history.anchored, false);
  let previous = '0'.repeat(64);
  for (const { hash, ...call } of history.calls) {
    assert.equal(call.previousHash, previous);
    assert.equal(roomHash(JSON.stringify(call)), hash);
    previous = hash;
  }
  assert.equal((await roomHistory(pool, a, room.id, '5')).calls.length, 4);
  await assert.rejects(
    pool.query(
      "UPDATE second_look_room_calls SET record_hash=repeat('f',64) WHERE room_id=$1",
      [room.id],
    ),
    /immutable/,
  );
  await assert.rejects(
    pool.query('DELETE FROM second_look_room_calls WHERE room_id=$1', [
      room.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    captureRoomCall(
      pool,
      a,
      room.id,
      { ...input, key: randomUUID() },
      async () => ({
        slot: null,
        priceUsd6: '0',
        heldAtoms: null,
        bought60mAtoms: null,
        source: null,
        unavailable: [],
      }),
    ),
    code('CAPTURE_UNAVAILABLE'),
  );
  assert.equal((await roomHistory(pool, a, room.id)).calls.length, 9);
});
test('seat purchases charge once, bind intent and never silently change an active tier', async () => {
  const a = await user(),
    room = await createRoom(pool, a, 'Billing'),
    key = randomUUID();
  await assert.rejects(
    purchaseRoomSeats(pool, a, room.id, 2, '4000000', key),
    code('INSUFFICIENT_BALANCE'),
  );
  await creditVerifiedDeposit(pool, {
    accountId: a,
    reference: 'synthetic-room-test-' + randomUUID(),
    amountUsd6: '20000000',
  });
  const r = await Promise.all([
    purchaseRoomSeats(pool, a, room.id, 2, '4000000', key),
    purchaseRoomSeats(pool, a, room.id, 2, '4000000', key),
  ]);
  assert.equal(r.filter((p) => p.replayed).length, 1);
  const txs = await pool.query(
    'SELECT * FROM second_look_room_purchases WHERE room_id=$1',
    [room.id],
  );
  assert.equal(txs.rowCount, 1);
  assert.equal((await listRooms(pool, a)).rooms[0].capacity, 12);
  await assert.rejects(
    purchaseRoomSeats(pool, a, room.id, 3, '6000000', key),
    code('PURCHASE_KEY_CONFLICT'),
  );
  await assert.rejects(
    purchaseRoomSeats(pool, a, room.id, 3, '6000000', randomUUID()),
    code('ACTIVE_SEAT_TIER'),
  );
  await assert.rejects(
    purchaseRoomSeats(pool, a, room.id, 2, '1', randomUUID()),
    code('PRICE_CHANGED'),
  );
  assert.equal((await getBalance(pool, a)).availableUsd6, '16000000');
});
test('routes reject client-supplied market evidence and all room tables deny PUBLIC', async () => {
  const a = await user(),
    room = await createRoom(pool, a, 'Routes');
  const req = new Request(
    origin + '/api/second-look/rooms/' + room.id + '/calls',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        walletId: randomUUID(),
        mint,
        note: '',
        key: randomUUID(),
        priceUsd6: '1',
      }),
    },
  );
  await assert.rejects(
    roomsRoutes(pool, req, 'second-look/rooms/' + room.id + '/calls', {
      accountId: a,
      tokenHash: 'test',
    }),
    code('INVALID_REQUEST'),
  );
  const { rows } = await pool.query(
    "SELECT relname,relrowsecurity,relacl::text[] FROM pg_class WHERE relname IN ('second_look_rooms','second_look_room_members','second_look_room_invites','second_look_room_proof_challenges','second_look_room_wallet_proofs','second_look_room_calls','second_look_room_purchases')",
  );
  assert.equal(rows.length, 7);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true);
    assert.ok(!(row.relacl ?? []).some((x) => x.startsWith('=')));
  }
});

test('price observations reserve bounded requests, deduplicate and never overwrite history', async () => {
  const { runRoomPriceWorker } =
    await import('../server/second-look/room-price-worker.ts');
  const { SOLANA_NETWORKS } = await import('../server/solana/validation.ts');
  const a = await user(),
    w = await wallet(a),
    room = await createRoom(pool, a, 'Price capture');
  await prove(a, w);
  await captureRoomCall(pool, a, room.id, {
    walletId: w.id,
    mint,
    note: '',
    key: randomUUID(),
  });
  const env = {
    ...process.env,
    CONCLAVE_ROOMS_CAPTURE_ENABLED: 'true',
    CONCLAVE_ROOMS_RPC_URL: 'https://rpc.example.test/',
    CONCLAVE_ROOMS_JUPITER_API_KEY: 'fixture',
    CONCLAVE_ROOMS_DAILY_PROVIDER_CALLS: '9',
  };
  let requests = 0,
    price = 2;
  const seconds = Math.floor(Date.now() / 1000);
  const fetcher = async (url, init) => {
    requests++;
    if (String(url).startsWith('https://api.jup.ag/price/v3'))
      return Response.json({ [mint]: { usdPrice: price, blockId: 999 } });
    const { method } = JSON.parse(init.body);
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result:
        method === 'getGenesisHash'
          ? SOLANA_NETWORKS['mainnet-beta'].genesisHash
          : seconds,
    });
  };
  assert.equal(
    (
      await runRoomPriceWorker(pool, {
        env: { ...env, CONCLAVE_ROOMS_CAPTURE_ENABLED: 'false' },
        fetcher,
      })
    ).state,
    'disabled',
  );
  assert.equal(requests, 0);
  const first = await runRoomPriceWorker(pool, { env, fetcher });
  assert.equal(first.observations, 1);
  assert.equal(requests, 3);
  assert.equal(
    (await runRoomPriceWorker(pool, { env, fetcher })).observations,
    0,
  );
  price = 3;
  await assert.rejects(
    runRoomPriceWorker(pool, { env, fetcher }),
    /Conflicting/,
  );
  assert.equal(
    (await runRoomPriceWorker(pool, { env, fetcher })).state,
    'request_budget',
  );
  assert.equal(requests, 9);
  assert.equal(
    (
      await pool.query(
        'SELECT price_usd6::text FROM second_look_room_prices WHERE mint=$1 AND slot=999',
        [mint],
      )
    ).rows[0].price_usd6,
    '2000000',
  );
  await assert.rejects(
    pool.query('DELETE FROM second_look_room_prices WHERE mint=$1', [mint]),
    /immutable/,
  );
});

test('results and completed-day commitments preserve access, exact roots and unknown coverage', async () => {
  const { encryptText, configuredKeyring } =
    await import('../server/core/encryption.ts');
  const { sharedRoomResults } =
    await import('../server/second-look/room-results.ts');
  const { prepareRoomAnchor } =
    await import('../server/second-look/room-anchors.ts');
  const { ROOM_ANCHOR_PROGRAM } =
    await import('../server/second-look/guard-transaction.ts');
  const { SOLANA_NETWORKS } = await import('../server/solana/validation.ts');
  const { createHash } = await import('node:crypto');
  const a = await user(),
    outsider = await user(),
    w = await wallet(a),
    room = await createRoom(pool, a, 'Daily commitment');
  const at = new Date(Date.now() - 172800000).toISOString(),
    day = at.slice(0, 10);
  const call = {
    schema: 1,
    environment: 'captured',
    roomId: room.id,
    sequence: '1',
    mint,
    caller: w.address,
    note: '',
    at,
    ownership: 'wallet_signature',
    evidence: {
      slot: '50',
      priceUsd6: '1000000',
      heldAtoms: '100',
      bought60mAtoms: null,
      source: 'fixture',
      unavailable: [],
    },
    previousHash: '0'.repeat(64),
  };
  const raw = JSON.stringify(call),
    hash = roomHash(raw);
  await pool.query(
    'INSERT INTO second_look_room_calls(room_id,sequence,caller_id,captured_at,origin_key,request_hash,previous_hash,record_hash,record_ciphertext) VALUES($1,1,$2,$3,$4,$5,$6,$5,$7)',
    [
      room.id,
      a,
      at,
      randomUUID(),
      hash,
      call.previousHash,
      await encryptText(raw, `room:${room.id}:call:1`, configuredKeyring()),
    ],
  );
  await pool.query(
    'UPDATE second_look_rooms SET head_hash=$2,next_sequence=2 WHERE id=$1',
    [room.id, hash],
  );
  for (const [i, hours] of [1, 24].entries())
    await pool.query(
      "INSERT INTO second_look_room_prices(mint,slot,observed_at,price_usd6,source) VALUES($1,$2,$3,$4,'jupiter_price_v3')",
      [
        mint,
        10000 + i,
        new Date(Date.parse(at) + hours * 3600000),
        hours === 1 ? '1200000' : '800000',
      ],
    );
  await assert.rejects(sharedRoomResults(pool, outsider, room.id));
  const results = await sharedRoomResults(pool, a, room.id);
  assert.equal(results.results.length, 1);
  assert.equal(results.results[0].outcome.soldIntoCallBps, null);
  assert.equal(results.callers[0].sampleTooSmall, true);
  const env = {
    CONCLAVE_ROOMS_ANCHOR_PUBLISHER: w.address,
    CONCLAVE_ROOMS_ANCHOR_RPC_URL: 'https://rpc.example.test',
  };
  let requests = 0,
    checkpoint = null;
  const fetcher = async (_u, init) => {
    requests++;
    const q = JSON.parse(init.body);
    return Response.json({
      id: 1,
      jsonrpc: '2.0',
      result:
        q.method === 'getGenesisHash'
          ? SOLANA_NETWORKS['mainnet-beta'].genesisHash
          : {
              value:
                checkpoint && q.params[0] === checkpoint.address
                  ? {
                      owner: ROOM_ANCHOR_PROGRAM,
                      executable: false,
                      data: [checkpoint.bytes.toString('base64'), 'base64'],
                    }
                  : null,
            },
    });
  };
  await assert.rejects(
    prepareRoomAnchor(pool, outsider, room.id, day, env, fetcher),
    code('ROOM_OWNER_REQUIRED'),
  );
  await assert.rejects(
    prepareRoomAnchor(pool, a, room.id, '1969-12-31', env, fetcher),
    code('INVALID_ANCHOR_DAY'),
  );
  assert.equal(requests, 0);
  const prepared = await prepareRoomAnchor(pool, a, room.id, day, env, fetcher);
  assert.equal(prepared.anchored, false);
  assert.equal(prepared.instructions.length, 2);
  assert.equal(prepared.root, hash);
  const bytes = Buffer.alloc(128);
  createHash('sha256')
    .update('account:Checkpoint')
    .digest()
    .subarray(0, 8)
    .copy(bytes);
  Buffer.from(bs58.decode(prepared.chainRoom)).copy(bytes, 8);
  bytes.writeBigInt64LE(BigInt(Math.floor(Date.parse(day) / 86400000)), 40);
  bytes.writeBigUInt64LE(1n, 48);
  Buffer.from(hash, 'hex').copy(bytes, 88);
  bytes.writeBigUInt64LE(12345n, 120);
  checkpoint = { address: prepared.checkpoint, bytes };
  assert.equal(
    (await prepareRoomAnchor(pool, a, room.id, day, env, fetcher)).anchored,
    true,
  );
  bytes[88] ^= 1;
  await assert.rejects(
    prepareRoomAnchor(pool, a, room.id, day, env, fetcher),
    code('ANCHOR_MISMATCH'),
  );
});
