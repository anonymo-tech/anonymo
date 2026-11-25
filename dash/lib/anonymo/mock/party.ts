import {
  partyDiceCommit, partyDiceValue, partyNonce, PARTY_BASE,
  type Campaign, type PartyAction, type PartyCreate, type PartyRoom,
} from '../party.ts';
import { mentionsSelfHarm } from '../safety.ts';

type MockRoom = {
  view: PartyRoom;
  seats: Map<string, number>;
  invite: string;
  seed: string;
  turn: number;
};
type WireRequest = { path: string; body: Record<string, unknown>; call: string };
type WireReply = { call: string; status: number; data: unknown };
type Art = (host: string, scene: string) => Promise<{ image: string; receipt: PartyRoom['artReceipt'] } | null>;

const TTL = 7_200_000;
const opening: Campaign = {
  scene: 'In the blue hour, a lantern burns over the old ferry house. A silver bell rings beyond the mist. The door is ajar.',
  inventory: [], flags: [], initiative: [], log: [], summary: '',
};
const scenes = [
  'The ferry keeper has left a brass key on the sill. A chart on the wall marks a landing called Bellwater, where the river turns silver at low tide.',
  'A narrow skiff bumps against the dock. Under the stern seat you find a sealed letter addressed to the Bellwater keeper. The second bell is about to ring.',
  'Across the water, a lantern rises on the far bridge. Someone has answered your signal. The current eases, and the first stars appear over the ferry house.',
];

export function createDemoParty(art: Art) {
  const rooms = new Map<string, MockRoom>();
  let channel: BroadcastChannel | null = null;
  const visitors = new Map<string, (response: WireReply) => void>();
  const payers = new Map<string, string>();
  const queues = new Map<string, Promise<unknown>>();
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const fail = (code: number, type: string, message: string) => json({ error: { code, type, message } }, code);
  const expired = () => fail(410, 'party_closed', 'This Party room has closed.');

  function snapshot(room: MockRoom, slot: number) {
    return { ...room.view, you: slot, host: slot === 1, checkpoint: slot === 1 ? room.view.checkpoint : null };
  }

  function changed(room: MockRoom) {
    room.view.version++;
    room.view.expiresAt = Date.now() + TTL;
  }

  async function access(path: string, body: Record<string, unknown>, ownedOnly = false) {
    const match = /^\/v1\/party\/rooms\/([^/]+)\/(join|state|action)$/.exec(path);
    const room = match ? rooms.get(match[1]) : null;
    if (!room || !match || room.view.expiresAt <= Date.now()) {
      if (room) { rooms.delete(room.view.id); payers.delete(room.view.id); }
      return ownedOnly ? null : expired();
    }
    const id = room.view.id;
    if (match[2] === 'join') {
      if (body.adult !== true || body.invite !== room.invite) return fail(403, 'party_invalid_invite', 'This invite is unavailable.');
      if (room.seats.size >= 6) return fail(409, 'party_full', 'This Party room is full.');
      const token = partyNonce();
      const used = new Set(room.seats.values());
      const slot = [2, 3, 4, 5, 6].find((n) => !used.has(n))!;
      room.seats.set(token, slot);
      room.view.players.push({ slot, host: false });
      changed(room);
      return json({ token, room: snapshot(room, slot) });
    }
    const slot = room.seats.get(String(body.token));
    if (!slot) return fail(403, 'party_invalid_player', 'Your seat in this room is unavailable.');
    if (match[2] === 'state') return json(snapshot(room, slot));
    const action = body as PartyAction & { token: string };
    if (action.type === 'close' && slot !== 1) return fail(403, 'party_host_only', 'Only the host can close the room.');
    if (action.type === 'leave' || action.type === 'close') {
      if (slot === 1) { rooms.delete(id); payers.delete(id); }
      else {
        room.seats.delete(action.token);
        room.view.players = room.view.players.filter((p) => p.slot !== slot);
        if (room.view.roller === slot && !room.view.roll?.reveal) { room.view.roll = null; room.view.roller = null; room.seed = ''; }
        changed(room);
      }
      return json({ room: null });
    }
    if (queues.has(id)) return fail(409, 'party_busy', 'Another Party action is in progress.');
    const apply = async () => {
      const roll = room.view.roll;
      if (action.type === 'commit') {
        if (roll && !roll.reveal) return fail(409, 'party_pending_roll', 'Reveal the pending roll first.');
        room.seed = partyNonce();
        const number = (roll?.number ?? room.view.version) + 1;
        room.view.roll = { number, sides: action.sides, commit: await partyDiceCommit(id, number, action.sides, room.seed), reveal: null, value: null };
        room.view.roller = slot;
      } else if (action.type === 'reveal') {
        if (!roll || roll.commit !== action.commit || slot !== room.view.roller)
          return fail(409, 'party_invalid_roll', 'Reveal the commitment you received for your current roll.');
        if (!roll.reveal) {
          roll.reveal = room.seed + '.' + action.nonce;
          roll.value = await partyDiceValue(room.seed, action.nonce, roll.sides);
          room.seed = '';
        }
      } else if (action.type === 'discard') {
        if (slot !== 1 || !roll || roll.reveal) return fail(403, 'party_host_only', 'Only the host can discard a pending roll.');
        room.view.roll = null;
        room.view.roller = null;
        room.seed = '';
      } else if (action.type === 'turn') {
        if (mentionsSelfHarm(action.text)) return json({ crisis: true });
        const scene = scenes[room.turn++ % scenes.length];
        room.view.campaign = {
          ...room.view.campaign, scene, summary: scene, inventory: ['Brass key'],
          log: [...room.view.campaign.log, { player: slot, action: action.text, scene }].slice(-6),
        };
        room.view.checkpoint = partyNonce();
        if (room.view.artEnabled) {
          const result = await art(payers.get(id) ?? '', scene).catch(() => null);
          room.view.art = result?.image ?? null;
          room.view.artReceipt = result?.receipt ?? null;
        }
      }
      changed(room);
      return json({ room: snapshot(room, slot) });
    };
    const running = apply();
    queues.set(id, running);
    try { return await running; } finally { queues.delete(id); }
  }

  // The host's tab keeps live state. Other local tabs can join without writing it to browser storage.
  function connect() {
    if (channel || typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return channel;
    channel = new BroadcastChannel('anonymo.party.preview.v1');
    channel.onmessage = ({ data }: MessageEvent<WireRequest | WireReply>) => {
      if ('status' in data) { visitors.get(data.call)?.(data); return; }
      void access(data.path, data.body, true).then(async (result) => {
        if (result) channel?.postMessage({ call: data.call, status: result.status, data: await result.json() });
      }).catch(() => {});
    };
    return channel;
  }

  return async (request: Request, path: string) => {
    if (path === PARTY_BASE && request.method === 'GET') return json({ art: true, discord: false });
    if (request.method !== 'POST') return null;
    const body = await request.json() as Record<string, unknown>;
    const bus = connect();
    if (path === PARTY_BASE + '/rooms') {
      if (body.adult !== true || !request.headers.has('authorization')) return fail(403, 'party_host_required', 'A host key and age confirmation are required.');
      const { checkpoint, mature, art: artEnabled } = body as PartyCreate;
      const id = crypto.randomUUID();
      const token = partyNonce();
      const invite = partyNonce();
      const view: PartyRoom = {
        id, campaignId: checkpoint?.id ?? id, mature, artEnabled, discord: false, discordLinked: false,
        you: 1, host: true, version: 1, expiresAt: Date.now() + TTL, players: [{ slot: 1, host: true }],
        campaign: checkpoint?.campaign ?? structuredClone(opening), roll: null, roller: null, art: null,
        receipt: null, artReceipt: null, checkpoint: partyNonce(),
      };
      rooms.set(id, { view, invite, seed: '', turn: view.campaign.log.length, seats: new Map([[token, 1]]) });
      payers.set(id, request.headers.get('authorization') ?? '');
      return json({ token, invite, room: view });
    }
    const hit = await access(path, body, true);
    if (hit || !bus) return hit ?? expired();
    return new Promise<Response>((resolve) => {
      const call = crypto.randomUUID();
      const timer = setTimeout(() => { visitors.delete(call); resolve(expired()); }, 2000);
      visitors.set(call, (reply) => {
        clearTimeout(timer);
        visitors.delete(call);
        resolve(json(reply.data, reply.status));
      });
      bus.postMessage({ path, body, call });
    });
  };
}
