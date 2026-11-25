import { z } from "zod";
import { campaignSchema, DICE_SIDES } from "./rules.ts";

export const DISCORD_PATH = "/v1/party/discord/interactions";
export const roomId = z.string().uuid();
export const token = z.string().regex(/^[a-f0-9]{64}$/);
export const turnText = z.string().trim().min(1).max(1200);
export const sides = z.number().int().refine((n) => DICE_SIDES.some((side) => n === side));
export const createInput = z.object({
  adult: z.literal(true),
  mature: z.boolean().default(false),
  art: z.boolean().default(false),
  discord: z.boolean().default(false),
  checkpoint: z.object({ id: roomId, campaign: campaignSchema, mature: z.boolean(), signature: token }).optional(),
}).strict();
export const joinInput = z.object({ adult: z.literal(true), invite: token }).strict();
export const actionInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), text: turnText, token }).strict(),
  z.object({ type: z.literal("commit"), sides, token }).strict(),
  z.object({ type: z.literal("reveal"), commit: token, nonce: token, token }).strict(),
  z.object({ type: z.literal("discard"), token }).strict(),
  z.object({ type: z.literal("leave"), token }).strict(),
  z.object({ type: z.literal("close"), token }).strict(),
]);
