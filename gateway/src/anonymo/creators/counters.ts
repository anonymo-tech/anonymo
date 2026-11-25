import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const DAILY_CAP = 5_000_000_000_000n;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const weekOf = (ms: number) => Math.floor(ms / WEEK_MS);
export const weekDate = (week: number) => dayOf(week * WEEK_MS);
const hash = (salt: string, value: string) => createHmac("sha256", Buffer.from(salt, "hex")).update(value).digest("hex");

const CAP = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local allowed = math.max(0, math.min(tonumber(ARGV[1]), tonumber(ARGV[2]) - used))
if allowed > 0 then
  redis.call('INCRBY', KEYS[1], allowed)
  if used == 0 then redis.call('EXPIRE', KEYS[1], 86400) end
end
return allowed
`;

const SKETCH = `
for i = 1, #KEYS do
  if ARGV[i] ~= '' then
    redis.call('PFADD', KEYS[i], ARGV[i])
    redis.call('EXPIRE', KEYS[i], i <= 2 and 86400 or tonumber(ARGV[5]))
  end
end
return {redis.call('PFCOUNT', KEYS[1]), redis.call('PFCOUNT', KEYS[2])}
`;

export interface CreatorCounters {
  cap(now: number, keyHash: string, creatorId: string, spend: bigint): Promise<{ allowed: bigint; epoch: string }>;
  visit(now: number, keyHash: string, characterId: string, newlyFunded: boolean): Promise<{ funded: number; newKeys: number }>;
  audience(now: number, characterId: string): Promise<{ unique: number; week2: number | null }>;
}

export class RedisCreatorCounters implements CreatorCounters {
  constructor(private readonly redis: Redis) {}

  private async salt(scope: string, seconds: number) {
    const name = `creators:salt:${scope}`;
    const value = randomBytes(32).toString("hex");
    if (await this.redis.set(name, value, "EX", seconds, "NX")) return value;
    const existing = await this.redis.get(name);
    if (!existing) throw new Error("Creator counter salt expired.");
    return existing;
  }

  async cap(now: number, keyHash: string, creatorId: string, spend: bigint) {
    const salt = await this.salt(`day:${dayOf(now)}`, 86_400);
    const digest = hash(salt, keyHash + creatorId);
    const allowed = await this.redis.eval(CAP, 1, `creators:cap:${digest}`, String(spend < DAILY_CAP ? spend : DAILY_CAP), String(DAILY_CAP));
    return { allowed: BigInt(allowed as number), epoch: createHash("sha256").update(salt).digest("hex") };
  }

  async visit(now: number, keyHash: string, characterId: string, newlyFunded: boolean) {
    const day = dayOf(now);
    const week = weekOf(now);
    const [today, current, previous] = await Promise.all([
      this.salt(`day:${day}`, 86_400),
      this.salt(`cohort:${week}`, 15 * 86_400),
      this.salt(`cohort:${week - 1}`, 15 * 86_400),
    ]);
    const todayHash = hash(today, `audience:${characterId}:${keyHash}`);
    const [funded, newKeys] = await this.redis.eval(SKETCH, 4,
      `creators:audience:${characterId}:${day}`, `creators:audience:${characterId}:${day}:new`,
      cohort(characterId, week, 1), cohort(characterId, week - 1, 2),
      todayHash, newlyFunded ? todayHash : "",
      hash(current, `audience:${characterId}:${keyHash}`),
      hash(previous, `audience:${characterId}:${keyHash}`), 22 * 86_400,
    ) as [number, number];
    return { funded, newKeys };
  }

  async audience(now: number, characterId: string) {
    const week = weekOf(now);
    const first = cohort(characterId, week - 2, 1);
    const second = cohort(characterId, week - 2, 2);
    const [unique, a, b, union] = await Promise.all([
      this.redis.pfcount(cohort(characterId, week, 1)),
      this.redis.pfcount(first),
      this.redis.pfcount(second),
      this.redis.pfcount(first, second),
    ]);
    return { unique, week2: overlapRate(a, b, union) };
  }
}

const cohort = (id: string, week: number, part: 1 | 2) => `creators:audience:${id}:${week}:${part}`;

export function overlapRate(first: number, second: number, union: number) {
  return first ? Math.round(100 * Math.max(0, Math.min(first, second, first + second - union)) / first) : null;
}
