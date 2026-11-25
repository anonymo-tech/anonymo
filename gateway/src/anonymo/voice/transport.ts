import { createHmac, randomUUID } from "node:crypto";
import type { Config } from "../../config.ts";
import { fail } from "../../lib/errors.ts";
import { SAMPLE_RATE } from "./audio.ts";

/** A media bridge connects PCM frames and events to VoiceSession. LiveKit currently issues credentials only. */
export interface VoiceConnection {
  send(event: object): void;
  audio(wav: ArrayBuffer): void;
  close(): void;
}

export function liveKitTicket(cfg: Config["moVoice"]["livekit"], now = Math.floor(Date.now() / 1000)) {
  if (!cfg.url || !cfg.key || !cfg.secret) fail(503, "LiveKit is unavailable.", "livekit_unavailable");
  const room = `call-${randomUUID()}`;
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = {
    iss: cfg.key, sub: randomUUID(), nbf: now - 5, exp: now + 120,
    video: { room, roomJoin: true, canSubscribe: true, canPublish: true, canPublishSources: ["microphone"], canPublishData: false },
  };
  const jwt = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = createHmac("sha256", cfg.secret).update(jwt).digest("base64url");
  return { transport: "livekit", url: cfg.url, room, token: `${jwt}.${signature}`, codec: "opus", sample_rate: SAMPLE_RATE };
}
