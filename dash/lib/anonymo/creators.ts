import type { Address, Hex } from 'viem';

export const CREATOR_API = '/api/v1/creators';
export const REFERRAL_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export type CreatorCard = {
  id: string; name: string; description: string; tags: string[]; adult: boolean; wallet: Address; shareBps: number; seed: string;
};
export type PublishCharacter = {
  cardHash: string; creatorWallet: Address; name: string; description: string; personality: string; scenario: string;
  tags: string[]; adult: boolean; shareBps: number;
};
export type CreatorStats = CreatorCard & {
  chats: number; spend: string; held: string; frozen: string; audience: { unique: number; week2: number | null } | null;
};
export type CreatorClaim = {
  wallet: Address; epoch: number; week: string; amount: string; proof: { hash: Hex; sum: string }[];
  tip: string; tx: Hex | null; root: Hex;
};
export type CreatorContracts = {
  chainId: number; rpc: string; usdg: Address; payouts: Address | null; boosts: Address | null; votes: Address | null;
};
export type CreatorVotes = {
  epoch: number; closesAt: string; options: { ballot: number; option: Hex; label: string; tally: string }[];
};

export function shareBasisPoints(text: string) {
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text.trim());
  const bps = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : NaN;
  if (!Number.isInteger(bps) || bps > 1500) throw new Error('Enter a share between 0% and 15%.');
  return bps;
}

export function discoverQuery(q: string, tag: string, adult: boolean) {
  return new URLSearchParams({ q: q.trim(), tag: tag.trim(), adult: adult ? '1' : '0' });
}

export function creatorThumb(seed: string) {
  const value = Number.parseInt(seed.slice(0, 6), 16) || 0;
  return { hue: value % 360, angle: 22 + value % 56, x: 23 + value % 55 };
}
