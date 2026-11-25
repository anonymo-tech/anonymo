import type { Hono } from "hono";
import { bearer } from "../../api/auth.ts";
import { runChat } from "../../api/chat.ts";
import { clientIp, readJson } from "../../api/common.ts";
import type { Ctx } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { sha256 } from "../../lib/util.ts";
import { assertKeyPolicy, isSealedRequest, readKeyPolicy } from "../keys/caps.ts";
import { isTopic, type Topic } from "./packs.ts";

export type AskMoRequest = { question: string; topic: Topic | null; opinion: boolean };
const QUESTION_MAX = 4000;

export function askMoRoutes(app: Hono, ctx: Ctx) {
  const mount = (path: string, opinion: boolean) => {
    app.post(path, async (c) => {
      c.header("cache-control", "no-store");
      const secret = bearer(c.req.header("authorization"));
      if (!secret) fail(401, "An Anonymo API key is required.", "invalid_key");
      // These routes sit outside the chat URL matched by the key policy middleware.
      const policy = await readKeyPolicy(ctx.db, sha256(secret));
      await assertKeyPolicy(ctx.db, policy, {
        ip: policy?.ipAllow?.length ? clientIp(c, ctx.cfg.trustProxy) : null,
        sealed: isSealedRequest(null, c.req.header("x-anonymo-sealed")),
      });
      const { question, topic = null } = await readJson(c);
      if (typeof question !== "string" || !question.trim() || question.length > QUESTION_MAX || (topic !== null && !isTopic(topic)))
        fail(400, "Send a question of 1–4000 characters and a topic from Ask Mo, or omit the topic.", "invalid_request");
      if (opinion && !ctx.cfg.features.council)
        fail(503, "Second Opinion is unavailable on this gateway.", "council_unavailable");
      return runChat(ctx, c, "chat", undefined, { question: question.trim(), topic, opinion });
    });
  };
  mount("/v1/ask", false);
  mount("/v1/ask/second-opinion", true);
}
