import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { campaignSave, partyNonce, readPartyInvite, verifyPartyRoll } from '../lib/anonymo/party.ts';
import { setupReturn } from '../lib/anonymo/setup-return.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';
import { campaignMemory, campaignsFromMemory } from '../lib/anonymo/vault-memory/party.ts';
import { memoryKeys, openItem, sealItem } from '../lib/anonymo/vault-memory/crypto.ts';

test('Party is independently switchable, shown in demo and a safe setup destination', () => {
  assert.equal(parseUpdates().has('party'), false);
  assert.equal(parseUpdates('free,party').has('party'), true);
  assert.equal(updateOn('party', true), true);
  assert.deepEqual(setupReturn('/dashboard/party'), { href: '/dashboard/party', label: 'Party', needsCredit: true });
});

test('the dashboard and gateway crisis rules and resources stay aligned', async () => {
  const dashboard = await readFile(new URL('../lib/anonymo/safety.ts', import.meta.url), 'utf8');
  const gateway = await readFile(new URL('../../gateway/src/anonymo/region/party-signals.ts', import.meta.url), 'utf8');
  for (const rule of ['const SELF_HARM = [', 'export const CRISIS_LINES: CrisisLine[] = [']) {
    const block = (file) => file.slice(file.indexOf(rule)).split('];')[0];
    assert.equal(block(dashboard), block(gateway));
  }
});

test('a host opens Party, a guest joins for free, verifies dice, and receives crisis support', async () => {
  const gateway = createMockGateway({ delayMs: 0 });
  const options = { baseUrl: 'https://example.invalid', fetch: gateway.fetch };
  const guest = createAnonymoClient(options);
  const { key } = await guest.createKey();
  const host = createAnonymoClient({ ...options, key });
  const seat = await host.createParty({ adult: true, mature: false, art: false, discord: false });
  const link = `#invite=${seat.room.id}.${seat.invite}`;
  assert.deepEqual(readPartyInvite(link), { id: seat.room.id, invite: seat.invite });
  assert.equal(readPartyInvite(link + '&token=invalid'), null);
  const visitor = await guest.joinParty(seat.room.id, seat.invite);
  assert.equal(campaignSave(visitor.room), null);
  const room = (client, player, action) => client.partyAction(seat.room.id, player.token, action);
  const committed = await room(guest, visitor, { type: 'commit', sides: 20 });
  assert.equal(committed.room.roll.reveal, null);
  assert.equal(committed.room.roll.value, null);
  assert.equal((await host.partyState(seat.room.id, seat.token)).roll.commit, committed.room.roll.commit);
  const revealed = await room(guest, visitor, { type: 'reveal', commit: committed.room.roll.commit, nonce: partyNonce() });
  assert.equal(await verifyPartyRoll(seat.room.id, revealed.room.roll), true);
  assert.equal(await verifyPartyRoll(seat.room.id, { ...revealed.room.roll, value: revealed.room.roll.value + 1 }), false);
  assert.equal(await verifyPartyRoll(seat.room.id, { ...revealed.room.roll, reveal: revealed.room.roll.reveal + '.bad' }), false);
  assert.deepEqual(await room(guest, visitor, { type: 'turn', text: 'I want to die.' }), { crisis: true });
  const acted = await room(guest, visitor, { type: 'turn', text: 'I open the ferry house door.' });
  assert.equal(acted.room.campaign.log[0].player, 2);
  const saved = campaignSave(await host.partyState(seat.room.id, seat.token));
  assert.ok(saved);
  await room(host, seat, { type: 'close' });
  await assert.rejects(guest.partyState(seat.room.id, visitor.token), { status: 410 });
  const resumed = await host.createParty({ adult: true, mature: false, art: false, discord: false, checkpoint: saved.checkpoint });
  assert.deepEqual(resumed.room.campaign, saved.checkpoint.campaign);
  assert.equal(resumed.room.campaignId, seat.room.campaignId);
});

test('Vault Memory seals all campaign chunks and reconstructs the exact save', async () => {
  const saved = {
    savedAt: new Date().toISOString(),
    checkpoint: {
      id: crypto.randomUUID(), signature: partyNonce(), mature: false,
      campaign: {
        scene: '🗝️漢'.repeat(230), summary: 'Wait for the bell.',
        flags: ['Light the beacon'], initiative: [1], inventory: [],
        log: Array.from({ length: 6 }, () => ({ player: 1, action: 'Open the gate.\n'.repeat(40), scene: 'An empty path.'.repeat(60) })),
      },
    },
  };
  const keys = await memoryKeys(crypto.getRandomValues(new Uint8Array(32)));
  const chunks = await campaignMemory(saved);
  const rows = await Promise.all(chunks.map((item) => sealItem(keys, item, 1)));
  assert.ok(!JSON.stringify(rows).includes('Open the gate'));
  const decoded = await Promise.all(rows.map((row) => openItem(keys, row)));
  assert.deepEqual(campaignsFromMemory(decoded.toReversed()), [saved]);
  assert.deepEqual(campaignsFromMemory(decoded.slice(1)), []);
});
