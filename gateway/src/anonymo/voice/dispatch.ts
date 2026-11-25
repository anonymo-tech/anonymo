import type { Context } from "hono";

export const VOICE_DISPATCH = Symbol("voice request in transit");

export function isVoiceDispatch(c: Context) {
  return (c.env as { [VOICE_DISPATCH]?: true } | undefined)?.[VOICE_DISPATCH] === true;
}
