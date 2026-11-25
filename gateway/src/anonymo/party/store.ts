import { Redis } from "ioredis";
import { fail } from "../../lib/errors.ts";
import { decrypt, encrypt } from "../../lib/util.ts";
import type { StudioReceipt } from "../media/routes.ts";
import { newSeed, type DiceProof } from "./dice.ts";
import { ROOM_TTL_MS, type Campaign } from "./rules.ts";

export type Player = { slot: number; credential: string; host: boolean };
export type Room = {
  id: string;
  campaignId: string;
  hostKeyHash: string;
  mature: boolean;
  inviteHash: string | null;
  players: Player[];
  campaign: Campaign;
  artEnabled: boolean;
  art: string | null;
  artReceipt: StudioReceipt | null;
  receipt: string | null;
  roll: DiceProof | null;
  rollOwner: number | null;
  seed: string | null;
  lastUsedRoll: number;
  expiresAt: number;
  version: number;
  discord: { binding: string | null; host: string | null } | null;
};
export type RoomWriter = (room: Room | null) => Promise<void>;

const CHANNEL = "party:changed";
const LEASE_MS = 180_000;
const REPLAY_SECONDS = 360;
const UPDATE = `
  if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
  if ARGV[2] == '' then
    redis.call('del', KEYS[2])
  else
    redis.call('psetex', KEYS[2], ARGV[3], ARGV[2])
  end
  redis.call('publish', KEYS[3], ARGV[4])
  return 1
`;
const UNLOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end`;

export class PartyStore {
  private readonly rooms = new Map<string, { value: Room; timer: ReturnType<typeof setTimeout> }>();
  private readonly locks = new Set<string>();
  private readonly replay = new Map<string, number>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly redis?: Redis;
  private readonly subscriber?: Redis;
  private setup?: Promise<void>;

  constructor(url: string | undefined, private readonly secret: string, private readonly now = Date.now) {
    if (!url) return;
    this.redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 5000 });
    this.subscriber = this.redis.duplicate();
    this.redis.on("error", () => {});
    this.subscriber.on("error", () => {});
    this.redis.on("reconnecting", () => { this.setup = undefined; });
    this.subscriber.on("message", (_channel, id) => this.changed(id));
  }

  private async ready() {
    const redis = this.redis;
    const subscriber = this.subscriber;
    if (!redis || !subscriber) return;
    this.setup ??= (async () => {
      if (redis.status === "wait") await redis.connect();
      if (subscriber.status === "wait") await subscriber.connect();
      const [, save] = await redis.config("GET", "save");
      const [, append] = await redis.config("GET", "appendonly");
      const replication = await redis.info("replication");
      if (save !== "" || append !== "no" || !/^role:master\r?$/m.test(replication) || !/^connected_slaves:0\r?$/m.test(replication))
        throw new Error("Party Redis must have persistence disabled.");
      await subscriber.subscribe(CHANNEL);
    })().catch(() => {
      this.setup = undefined;
      fail(503, "Live room storage is unavailable.", "party_storage_unavailable");
    });
    await this.setup;
  }

  private changed(id: string) {
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  async watch(id: string, listener: () => void) {
    await this.ready();
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }

  async read(id: string): Promise<Room | null> {
    await this.ready();
    const raw = this.redis && await this.redis.get(`party:room:${id}`);
    const value = this.redis
      ? raw && JSON.parse(decrypt(`${this.secret}:party:${id}`, raw)) as Room
      : this.rooms.get(id)?.value;
    return value && value.expiresAt > this.now() ? structuredClone(value) : null;
  }

  async edit<T>(id: string, operation: (room: Room | null, write: RoomWriter) => Promise<T>): Promise<T> {
    await this.ready();
    const redis = this.redis;
    const lock = `party:lock:${id}`;
    const lease = newSeed();
    const acquired = redis
      ? await redis.set(lock, lease, "PX", LEASE_MS, "NX") === "OK"
      : !this.locks.has(id);
    if (!acquired) fail(409, "Another Party action is in progress. Try again shortly.", "party_busy");
    this.locks.add(id);
    try {
      const current = await this.read(id);
      return await operation(current, async (room) => {
        if (current && current.expiresAt <= this.now()) fail(410, "This room has expired.", "party_closed");
        if (room) {
          room.expiresAt = this.now() + ROOM_TTL_MS;
          room.version++;
        }
        if (redis) {
          const value = room ? encrypt(`${this.secret}:party:${id}`, JSON.stringify(room)) : "";
          const saved = await redis.eval(UPDATE, 3, lock, `party:room:${id}`, CHANNEL, lease, value, ROOM_TTL_MS, id);
          if (saved !== 1) fail(409, "This Party action expired.", "party_busy");
        } else {
          clearTimeout(this.rooms.get(id)?.timer);
          this.rooms.delete(id);
          if (room) {
            const timer = setTimeout(() => { this.rooms.delete(id); this.changed(id); }, ROOM_TTL_MS);
            timer.unref();
            this.rooms.set(id, { value: structuredClone(room), timer });
          }
          this.changed(id);
        }
      });
    } finally {
      this.locks.delete(id);
      if (redis) await redis.eval(UNLOCK, 1, lock, lease).catch(() => {});
    }
  }

  async claimInteraction(digest: string) {
    await this.ready();
    if (this.redis) return await this.redis.set(`party:discord:${digest}`, "1", "EX", REPLAY_SECONDS, "NX") === "OK";
    const now = this.now();
    for (const [key, end] of this.replay) if (end <= now) this.replay.delete(key);
    if (this.replay.has(digest) || this.replay.size >= 10_000) return false;
    this.replay.set(digest, now + REPLAY_SECONDS * 1000);
    return true;
  }

  close() {
    this.redis?.disconnect();
    this.subscriber?.disconnect();
    for (const { timer } of this.rooms.values()) clearTimeout(timer);
    this.rooms.clear();
    this.replay.clear();
    this.listeners.clear();
  }
}
