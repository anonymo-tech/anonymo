import { eq } from "drizzle-orm";
import { z } from "zod";
import type { KeyRow } from "../../api/auth.ts";
import { buildCharacterMessages, normalizeCard, type ChatMessage } from "../../characters/card.ts";
import type { Ctx } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { hasFundedKey } from "../freetier/policy.ts";
import { creatorCharacters } from "./schema.ts";

export const creatorId = z.string().uuid();
export const profileShape = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000),
  personality: z.string().trim().max(1000),
  scenario: z.string().trim().max(1000),
  tags: z.array(z.string().trim().min(1).max(32)).max(12),
};

export async function canSeeAdult(ctx: Ctx, key: KeyRow | null, adult: boolean) {
  return adult && await hasFundedKey(ctx, key);
}

export async function creatorChat(ctx: Ctx, body: Record<string, unknown>, id: unknown, key: KeyRow | null, adult: boolean) {
  const valid = creatorId.safeParse(id);
  if (!valid.success) fail(400, "Use a published character ID.", "invalid_character");
  const [row] = await ctx.db.select().from(creatorCharacters).where(eq(creatorCharacters.id, valid.data));
  if (!row || (row.adult && !await canSeeAdult(ctx, key, adult)))
    fail(404, "This character is unavailable.", "character_not_found");
  const card = normalizeCard({ name: row.name, description: row.description, personality: row.personality, scenario: row.scenario });
  const built = buildCharacterMessages(card, body.messages as ChatMessage[]);
  body.messages = built.messages;
  return row;
}
