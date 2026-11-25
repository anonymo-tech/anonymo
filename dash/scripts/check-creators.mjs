import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { creatorThumb, discoverQuery, REFERRAL_RE, shareBasisPoints } from '../lib/anonymo/creators.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

const baseUrl = 'https://workspace.invalid';

test('Creator Cut is a build switch and is visible in demo mode', () => {
  assert.equal(parseUpdates('').has('creators'), false);
  assert.equal(parseUpdates(' creators ').has('creators'), true);
  assert.equal(updateOn('creators', true), true);
});

test('published shares use integer basis points and thumbnails are deterministic', () => {
  for (const [text, expected] of [['0', 0], ['1.5', 150], ['14.99', 1499], ['15.00', 1500]])
    assert.equal(shareBasisPoints(text), expected);
  for (const text of ['15.01', '15e0', '-1', '1.001', '', 'bad']) assert.throws(() => shareBasisPoints(text));
  assert.deepEqual(creatorThumb('a47932'), creatorThumb('a47932'));
  assert.notDeepEqual(creatorThumb('a47932'), creatorThumb('103172'));
  assert.equal(String(discoverQuery('  moon & stars  ', ' slow burn ', false)), 'q=moon+%26+stars&tag=slow+burn&adult=0');
});

test('Discover attaches a key only for the declared adult listing and never forwards a referrer', async () => {
  const requests = [];
  const client = createAnonymoClient({
    baseUrl, key: 'fixture-key', // gitleaks:allow
    fetch: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ data: [], mature: false });
    },
  });
  await client.discover('', '', false);
  await client.discover('Moon', 'mystery', true);
  assert.equal(requests[0].init.headers.has('authorization'), false);
  assert.equal(requests[1].init.headers.has('authorization'), true);
  assert.equal(requests[1].init.referrerPolicy, 'no-referrer');
  assert.match(String(requests[1].url), /q=Moon&tag=mystery&adult=1$/);
});

test('demo directory filters cards, shows a payout proof and only accepts an invite before funding', async () => {
  const gateway = createMockGateway();
  const guest = createAnonymoClient({ baseUrl, fetch: gateway.fetch });
  const signup = await guest.createKey();
  const author = createAnonymoClient({ baseUrl, fetch: gateway.fetch, key: signup.key });
  const fresh = await guest.createKey();
  const invited = createAnonymoClient({ baseUrl, fetch: gateway.fetch, key: fresh.key });
  assert.ok((await guest.discover('', 'mystery', true)).data.length > 0);
  assert.ok((await guest.discover('', '', true)).data.every((card) => !card.adult));
  assert.equal((await author.discover('midnight', '', true)).data.length, 0);
  const link = await author.referralLink();
  assert.match(link.code, REFERRAL_RE);
  await assert.rejects(author.acceptReferral(link.code), /new, unfunded key/);
  assert.deepEqual(await invited.acceptReferral(link.code), { accepted: true });
  assert.deepEqual(await invited.acceptReferral(link.code), { accepted: true });
  const card = (await guest.discover('Atlas', 'fantasy', false)).data[0];
  assert.ok(card);
  assert.ok((await guest.creatorClaims(card.wallet))[0].tx);
  const votes = await guest.creatorVotes();
  assert.deepEqual([...new Set(votes.options.map(({ ballot }) => ballot))], [0, 1, 2]);
});
