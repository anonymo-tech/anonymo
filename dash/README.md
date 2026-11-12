# Anonymo dashboard

The web workspace for Anonymo (Backend §2 "dash", Overview §2): create a key, fund it, chat with the four model IDs,
compare council answers, read receipts and their inclusion proofs, import character cards, copy frontend presets, and the
public `/manifest` and `/leaderboard` pages. No email, name or identity fields anywhere, and no analytics.

It keeps the Conclave workspace layout (top bar, centred thread, answer cards with a model tab bar and Compare, the
floating dock with tools and composer, the purse, Paper Trail) under a new identity. Conclave's own features, server,
brand, films and i18n are gone.

## Run

```bash
npx -y pnpm@11.19.0 install
npx -y pnpm@11.19.0 dev          # http://localhost:5173
npx -y pnpm@11.19.0 typecheck
npx -y pnpm@11.19.0 test         # client, copy rules, Solana verifier, secret guard
npx -y pnpm@11.19.0 lint
npx -y pnpm@11.19.0 build && npx -y pnpm@11.19.0 start
```

## Live and demo mode

| Setting | Effect |
| --- | --- |
| `NEXT_PUBLIC_ANONYMO_API=https://…` | Gateway origin. Unset means demo mode. |
| `NEXT_PUBLIC_ANONYMO_DEMO=1` | Force demo mode. |
| `?demo=1` / `?demo=0` | Turn demo mode on or off for this tab (when an API is set). |
| `NEXT_PUBLIC_ANONYMO_VENICE_BADGE=1` | Show the "Built in Venice" badge (Overview §4, §10). Off by default. |

Demo mode serves every endpoint from an in-browser mock gateway (`lib/anonymo/mock/`) with fixtures that follow the
spec shapes. The same client code runs in both modes; only `fetch` differs. In demo mode the funds page can simulate a
confirmed deposit, and a prompt containing the word "reroute" shows a refused-then-rerouted answer and its refund.

The real gateway must allow the dashboard origin in CORS and expose `x-anonymo-receipt` and `x-anonymo-council-mode`
(`Access-Control-Expose-Headers`), or the browser cannot read them.

## What stays on the device

- The API key, only if the person ticks "Remember on this device" (otherwise for the tab only). It is sent only as the
  `Authorization` header.
- Receipt ids with their model and time, imported character cards, the last model picked, the 18+ answer.
- Conversations live in memory and are gone when the tab closes. Prompt and output text are never written to storage.

## API shapes the dashboard assumes

All in `lib/anonymo/types.ts` and `lib/anonymo/client.ts` (`API_PATHS`). Money is integer micro-USD (`*_musd`).
Where the spec names a field it is used as written; the rest are proposals for the owning workstream to confirm.

| Call | Shape | Owner |
| --- | --- | --- |
| `POST /keys` | body `{caps?}` → `{key, key_prefix, caps, created_at, deposit_addresses[]}`; `key` is shown once | WS05 |
| `GET /deposit-addresses` | `{data: [{chain, tokens[], address, confirmations, min_musd}]}`; chains `base, arbitrum, rhc, solana, tron, btc, ln` | WS05 |
| `POST /deposits/lightning` | `{amount_musd}` → `{invoice_id, bolt11, amount_sats, quote_musd, expires_at}` | WS05 |
| `GET /balance` | `{available_musd, held_musd, refused_refunded_musd, sources[{chain, token, address, deposited_musd, withdrawable_musd}], recent[{kind, amount_musd, ref, at}]}` | WS05 |
| `POST /withdraw` | `{chain, source_address, amount_musd \| "all"}` → `{id, chain, token, to, amount_musd, status, tx_hash}`; no destination field | WS05 |
| `POST /v1/chat/completions` | OpenAI SSE; headers `x-anonymo-refusal-catch`, `x-anonymo-council-mode`, `x-anonymo-sealed: required`; response header `x-anonymo-receipt`; council adds `anonymo_council: {mode, aggregator, proposers[{route_id, family, content, cost_musd, used}]}` on the final chunk | WS03, WS09 |
| `GET /v1/models` | OpenAI list plus `family, quant, weights_hash, attested, refusal_rate_30d` | WS04, WS09 |
| `GET /v1/receipts/{id}` | `{receipt: {request_id, model_id, routes[], weights_hash[], attestation_quote_hash, tokens{in,out}, cost_musd, refused, refused_routes[], refund_musd, ts}, signer, signature, leaf}` | WS09 |
| `GET /v1/receipts/{id}/proof` | `{request_id, leaf, proof[], root, hour, anchor{chain, contract, tx_hash, status}}`; sorted-pair keccak256 as in `gateway/src/receipts/merkle.ts` | WS09 |
| `GET /manifest` | `{generated_at, routes[{id, upstream, tier, family, model, quant, weights_hash, attested, serves[], enabled}]}` | WS09 |
| `GET /leaderboard` | `{generated_at, window_days, rows[{route_id, family, upstream, total, refused, refusal_rate}]}` | WS09 |
| `POST /v1/characters` | private card: `{visibility: "private", sealed_card, card_hash}`, sealed on the device with `lib/anonymo/card.ts` | existing gateway route |

Errors use the OpenAI shape. The UI explains `451 floor_blocked`, `409 sealed_unavailable`, `402 insufficient_balance`,
`401` and `429` without ever echoing the prompt.

## Copy rules (Overview §10), checked by `scripts/check-copy.mjs`

Say "no refusals for legal adult use". Never the phrases "no rules", "anything goes" or "unfiltered". The Venice badge
is the only Venice mention, behind its flag. No profit or investment language about $ANMO. "Fully private" only for
`anonymo-sealed` with its attestation; everything else is "zero retention", a policy. Adults only on every surface,
with an 18+ notice on entry.

## Layout

| Path | What |
| --- | --- |
| `app/` | Landing, `/dashboard/*` (chat, key, funds, receipts, characters, presets), public `/presets`, `/manifest`, `/leaderboard` |
| `components/dashboard/` | Workspace shell and dock, chat thread, answer card and council compare, panels |
| `lib/anonymo/` | Typed client, types, mock gateway, money, presets, proof check, device storage, character cards |
| `lib/guards/`, `components/dashboard/use-content-guard.ts` | Kept from Conclave: warns before a seed phrase, private key or API key is sent in a prompt |
| `server/solana/`, `lib/solana/` | Kept only as the reference WS05 ports the Solana USDC deposit verifier from, and because CI runs `scripts/check-solana.mjs` on it. Nothing in the app imports it; delete it with WS05's port and drop the CI step then. |
