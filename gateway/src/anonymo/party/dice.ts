import { randomBytes } from "node:crypto";
import { sha256 } from "../../lib/util.ts";

export type DiceProof = { number: number; sides: number; commit: string; reveal: string | null; value: number | null };
export const newSeed = () => randomBytes(32).toString("hex");
export const diceCommit = (id: string, number: number, sides: number, seed: string) =>
  sha256(`party-dice-v1:${id}:${number}:${sides}:${seed}`);

export function diceValue(seed: string, nonce: string, sides: number) {
  // A nonce chosen after the commitment keeps either side from choosing the result alone.
  const limit = 2 ** 32 - (2 ** 32 % sides);
  for (let counter = 0; ; counter++) {
    const value = parseInt(sha256(`party-roll-v1:${seed}:${nonce}:${counter}`).slice(0, 8), 16);
    if (value < limit) return value % sides + 1;
  }
}
