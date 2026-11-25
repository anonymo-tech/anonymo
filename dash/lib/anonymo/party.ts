import type { SpeechReceipt } from './types.ts';

export const PARTY_BASE = '/v1/party';
export const PARTY_HREF = '/dashboard/party';
export const PARTY_DICE = [4, 6, 8, 10, 12, 20, 100] as const;
export type Campaign = {
  scene: string;
  inventory: string[];
  flags: string[];
  initiative: number[];
  log: { player: number; action: string; scene: string }[];
  summary: string;
};
export type DiceProof = { number: number; sides: number; commit: string; reveal: string | null; value: number | null };
export type Checkpoint = { id: string; campaign: Campaign; mature: boolean; signature: string };
export type PartyRoom = {
  id: string;
  campaignId: string;
  mature: boolean;
  artEnabled: boolean;
  discord: boolean;
  discordLinked: boolean;
  you: number;
  host: boolean;
  expiresAt: number;
  version: number;
  players: { slot: number; host: boolean }[];
  campaign: Campaign;
  roll: DiceProof | null;
  roller: number | null;
  art: string | null;
  receipt: string | null;
  artReceipt: SpeechReceipt | null;
  checkpoint: string | null;
};
export type PartySeat = { token: string; room: PartyRoom; invite?: string };
export type PartyCreate = { adult: true; mature: boolean; art: boolean; discord: boolean; checkpoint?: Checkpoint };
export type PartyAction =
  | { type: 'turn'; text: string }
  | { type: 'commit'; sides: number }
  | { type: 'reveal'; commit: string; nonce: string }
  | { type: 'leave' | 'close' | 'discard' };
export type PartyResult =
  | { crisis: true; receipt?: string | null }
  | { room: PartyRoom | null; refused?: boolean; receipt?: string | null; artError?: string };

const idPattern = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const hex64 = /^[a-f0-9]{64}$/;
export function readPartyInvite(fragment: string) {
  const match = new RegExp(`^#invite=(${idPattern})\\.([a-f0-9]{64})$`).exec(fragment);
  return match ? { id: match[1], invite: match[2] } : null;
}

export const partyNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, '0')).join('');
async function sha256(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

export const partyDiceCommit = (room: string, number: number, sides: number, seed: string) =>
  sha256(`party-dice-v1:${room}:${number}:${sides}:${seed}`);

export async function partyDiceValue(seed: string, nonce: string, sides: number) {
  const limit = 2 ** 32 - (2 ** 32 % sides);
  for (let counter = 0; ; counter++) {
    const value = parseInt((await sha256(`party-roll-v1:${seed}:${nonce}:${counter}`)).slice(0, 8), 16);
    if (value < limit) return value % sides + 1;
  }
}

export async function verifyPartyRoll(room: string, roll: DiceProof) {
  if (!roll.reveal || !Number.isSafeInteger(roll.number) || roll.number < 1 || !PARTY_DICE.some((side) => side === roll.sides)) return false;
  const [seed, nonce, extra] = roll.reveal.split('.');
  if (extra !== undefined || !hex64.test(seed) || !hex64.test(nonce)) return false;
  return await partyDiceCommit(room, roll.number, roll.sides, seed) === roll.commit &&
    await partyDiceValue(seed, nonce, roll.sides) === roll.value;
}

export type CampaignSave = { checkpoint: Checkpoint; savedAt: string };
export function campaignSave(room: PartyRoom): CampaignSave | null {
  return room.host && room.checkpoint ? {
    checkpoint: { id: room.campaignId, campaign: room.campaign, mature: room.mature, signature: room.checkpoint },
    savedAt: new Date().toISOString(),
  } : null;
}

export function readCampaignSave(raw: unknown): CampaignSave | null {
  if (!raw || typeof raw !== 'object') return null;
  const { checkpoint, savedAt } = raw as Partial<CampaignSave>;
  return checkpoint && new RegExp(`^${idPattern}$`).test(checkpoint.id) && hex64.test(checkpoint.signature) &&
    typeof checkpoint.mature === 'boolean' && typeof checkpoint.campaign?.scene === 'string' &&
    typeof savedAt === 'string' && Number.isFinite(Date.parse(savedAt)) ? { checkpoint, savedAt } : null;
}
