import type { Address, Hex } from 'viem';
import type { CreatorCard, CreatorClaim, CreatorContracts, CreatorStats, CreatorVotes } from '../creators.ts';

export const DEMO_CREATOR_WALLET = '0x1111111111111111111111111111111111111111'; // gitleaks:allow
const OTHER_WALLET = '0x2222222222222222222222222222222222222222'; // gitleaks:allow
export const creatorContracts: CreatorContracts = {
  chainId: 4663, rpc: '', usdg: '0x3333333333333333333333333333333333333333', // gitleaks:allow
  payouts: '0x4444444444444444444444444444444444444444', // gitleaks:allow
  boosts: '0x5555555555555555555555555555555555555555', // gitleaks:allow
  votes: '0x6666666666666666666666666666666666666666', // gitleaks:allow
};
const WEEK = 604_800_000;
const CURRENT_EPOCH = Math.floor(Date.now() / WEEK);
const sha = (value: string) => `0x${value.repeat(64)}` as Hex;
const claimed = new Set<string>();
const tips = new Map<Address, number>();
const weights = new Map<Address, number>();
const votes = new Map<number, Hex>();

export const creatorFixtures: CreatorStats[] = [
  {
    id: '10000000-0000-4000-8000-000000000001', name: 'The Atlas Keeper',
    description: 'An archivist mapping paths through a library that moves at sundown.',
    wallet: DEMO_CREATOR_WALLET, tags: ['fantasy', 'mystery'], shareBps: 1200, adult: false, seed: '6c48a7',
    chats: 237, spend: '18.72', held: '2.2464', frozen: '0', audience: { unique: 86, week2: 31 },
  },
  {
    id: '10000000-0000-4000-8000-000000000002', name: 'Signal at Low Tide',
    description: 'A lighthouse operator with a broken radio and a habit of picking up impossible signals.',
    wallet: OTHER_WALLET, tags: ['mystery', 'slow burn'], shareBps: 1000, adult: false, seed: 'a654f5',
    chats: 150, spend: '9.5', held: '0.95', frozen: '0', audience: { unique: 48, week2: 22 },
  },
  {
    id: '10000000-0000-4000-8000-000000000003', name: 'After Midnight',
    description: 'A late-night radio host taking calls as the city falls quiet.',
    wallet: OTHER_WALLET, tags: ['fiction', 'drama'], shareBps: 1500, adult: true, seed: 'd56991',
    chats: 45, spend: '4.2', held: '0.63', frozen: '0', audience: { unique: 19, week2: 18 },
  },
];

export function demoList(cards: CreatorStats[], q: string, tag: string, mature: boolean): CreatorCard[] {
  return cards.filter((card) => (mature || !card.adult) &&
    (!tag || card.tags.includes(tag)) && `${card.name} ${card.description}`.toLowerCase().includes(q))
    .sort((a, b) => (weights.get(b.wallet) ?? 0) - (weights.get(a.wallet) ?? 0))
    .map(({ chats: _chats, spend: _spend, held: _held, frozen: _frozen, audience: _audience, ...card }) => card);
}

export function demoClaims(wallet: string): CreatorClaim[] {
  const epoch = CURRENT_EPOCH - 2;
  return wallet === DEMO_CREATOR_WALLET && !claimed.has(`${epoch}:${wallet}`) ? [{
    epoch, wallet, week: new Date(epoch * WEEK).toISOString().slice(0, 10), root: sha('a'), tx: sha('b'),
    amount: '12400000', tip: '5000000', proof: [],
  }] : [];
}

export function demoClaim(epoch: number, wallet: Address) { claimed.add(`${epoch}:${wallet}`); }

export function demoCreatorAction(action: 'tip' | 'boost', wallet: Address, amount: number, unlock: boolean) {
  if (action === 'tip') {
    tips.set(wallet, (tips.get(wallet) ?? 0) + amount);
    return;
  }
  const next = (weights.get(wallet) ?? 0) + (unlock ? -amount : amount);
  if (next < 0) throw new Error('That amount exceeds your locked boost.');
  weights.set(wallet, next);
}

const options = ['Wren', 'Marin', 'The Atlas Keeper', 'Signal at Low Tide', 'Qwen', 'Gemma'];
export function demoVotes(): CreatorVotes {
  return {
    epoch: CURRENT_EPOCH, closesAt: new Date((CURRENT_EPOCH + 1) * WEEK).toISOString(),
    options: options.map((label, i) => {
      const ballot = Math.floor(i / 2);
      const option = sha(String(i + 1));
      return { ballot, option, label, tally: String(BigInt(40 + 12 * i + (votes.get(ballot) === option ? 12 : 0)) * 10n ** 18n) };
    }),
  };
}

export function demoVote(option: Hex) {
  const row = demoVotes().options.find((entry) => entry.option === option);
  if (row) votes.set(row.ballot, option);
}
