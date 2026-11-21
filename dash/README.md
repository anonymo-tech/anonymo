# Anonymo dashboard

The web workspace for Anonymo (Backend §2 "dash", Overview §2): create a key, fund it, chat with the four model IDs,
see every council seat, read receipts and their inclusion proofs, import character cards, copy frontend presets, and the
public `/manifest` and `/leaderboard` pages. No email, name or identity fields anywhere, and no analytics.

The workspace groups destinations by task on desktop. On phones, Overview, Chat and Funds have dedicated shortcuts and
the full navigation opens from More. The overview guides the visitor from a key to funding and a first chat. The site uses
Space Grotesk and the felt sleep-mask mascot from `public/mascot/`.

## Run

```bash
npx -y pnpm@11.19.0 install
npx -y pnpm@11.19.0 dev          # http://localhost:5173
npx -y pnpm@11.19.0 typecheck
npx -y pnpm@11.19.0 test         # client, wallet, copy rules, Solana verifier, secret guard
npx -y pnpm@11.19.0 lint
npx -y pnpm@11.19.0 build && npx -y pnpm@11.19.0 start
```

With the local demo server running (leave the API origin unset), set `WORKSPACE_PREVIEW_URL` to its origin and run `pnpm test:workspace-browser` to check the guided workspace in demo mode. Use `BROWSER_CHANNEL=chrome` for installed Chrome or install Chromium with `pnpm exec playwright-core install chromium`.

## Live and demo mode

| Setting | Effect |
| --- | --- |
| `NEXT_PUBLIC_ANONYMO_API=https://…` | Gateway origin. Unset means demo mode. |
| `NEXT_PUBLIC_ANONYMO_DEMO=1` | Force demo mode. |
| `?demo=1` / `?demo=0` | A live build uses its configured API and ignores this query parameter. |
| `NEXT_PUBLIC_ANONYMO_VENICE_BADGE=1` | Show the "Built in Venice" badge (Overview §4, §10). Off by default. |
| `NEXT_PUBLIC_ANONYMO_UPDATES=history,images,…` or `all` | Turn on updates that ship switched off (`lib/anonymo/updates.ts`): `history`, `images`, `usage`, `catchup`, `status`. Other optional updates include `compare`, `vanish`, `vault` and `video`. Faces, Night Call (`voice`), Move In (`movein`), Side by Side (`sidebyside`) and Tickets (`tickets`) are available in the live workspace. Demo mode shows all updates. |
| `NEXT_PUBLIC_ANONYMO_RHC_CHAIN_ID=46630` | Robinhood Chain testnet instead of mainnet (4663). Set `NEXT_PUBLIC_ANONYMO_RHC_RPC` with it. |
| `NEXT_PUBLIC_ANONYMO_EVM_NETWORKS='{"rhc":{"chainId":…,"rpcUrl":"…"}}'` | Override the chain id, RPC or name the wallet is switched to, per EVM chain (testnets, local chains). |

Demo mode serves every endpoint from an in-browser mock gateway (`lib/anonymo/mock/`) with fixtures that follow the
gateway's shapes. The same client code runs in both modes; only `fetch` differs. In demo mode the funds page can simulate
a confirmed USDG deposit or an ANMO payment, and a prompt containing the word "reroute" shows a refused-then-rerouted
answer.

Side by Side (`/dashboard/side-by-side`) asks three models at once and merges their answers; in demo mode a question
containing "reroute" is refused and rerouted in the anonymo-1 column only.

Against a local gateway (`cd gateway && bun run launch`, http://127.0.0.1:8787):

```bash
NEXT_PUBLIC_ANONYMO_API=http://127.0.0.1:8787 npx -y pnpm@11.19.0 dev
ANONYMO_API=http://127.0.0.1:8787 ANONYMO_TEST_KEY=<LAUNCH_KEY from gateway/.data/launch.env> \
  node --experimental-strip-types --test scripts/check-gateway-live.mjs
```

`check-gateway-live.mjs` runs the dashboard's client against the running gateway: CORS for every path, key creation,
deposit instructions, balance, withdrawals, models, manifest, leaderboard, chat with each of the four model IDs, the
receipt and its proof, and a sealed character card. The chat checks need the four model IDs seeded on the gateway
(`bun scripts/seed-upstreams.ts`, see `gateway/config/upstreams.yaml`) and council enabled (`ANONYMO_FEATURE_COUNCIL=1`).

## Paying from a browser wallet

`lib/anonymo/wallet.ts` and `components/dashboard/wallet-pay.tsx`, over plain EIP-1193 (`window.ethereum`) and viem. No
wallet SDK and no WalletConnect.

- **Stablecoins.** `GET /deposits` gives one `key_commit` per key and a DepositRouter per chain. The wallet is switched to
  the chain (added first if it does not know it), then pays `depositWithPermit(token, amount, keyCommit, deadline, v, r, s)`
  when the token's EIP-712 domain provably matches its `DOMAIN_SEPARATOR` (USDG), else `approve` then `deposit`. An
  existing allowance skips both. The page then polls `GET /deposits` until the row whose `ref` holds the transaction
  hash appears, credited or held. The sending wallet becomes the withdrawal address.
- **ANMO**, shown only when the instructions carry `coin`. Coins = USD / `price_usd`, rounded up to the smallest unit;
  amounts above `max_usd_per_payment` are refused, and nothing can be paid while `price_usd` is null. `CoinPay` burns the
  coins (`payWithPermit`, else `approve` + `pay`), and the page says so: the credit is the USD value at the time of
  crediting and is usage only, never withdrawable (`usage_only_usd` on `GET /balance`).
- Before anything is signed, the payment contract and the token must have code on the chosen chain: a call to an
  address with no code would "succeed" and move nothing.

## What stays on the device

- Faces keeps plush designs, expression tiles, imported card art, painted sheets and Stage backdrops in IndexedDB. The plush maker works without credits. Outfits, hats, glasses, face shapes, mouths and cheek details mix independently. Fabric, mask, eye stitching and felt each accept preset or custom colors. The image painter and backdrop painter use the gateway after a click. Wipe removes the saved artwork.

- The API key, only if the person ticks "Remember on this device" (otherwise for the tab only). It is sent only as the
  `Authorization` header.
- Receipt ids with their model and time, imported character cards, the last model picked, the 18+ answer.
- Conversations live in memory and are gone when the tab closes. Prompt and output text are never written to storage.
- Move In keeps the characters, chats and memory brought from other apps in IndexedDB (`anonymo.movein.v1`), live and
  demo apart. The export is read in the browser and never uploaded; Wipe deletes the database.
- Tickets keeps the keys of tickets the person gave, so what is left on a ticket can be taken back. Wipe removes them,
  and the credit can then no longer be taken back.
- Night Call keeps the voice that was picked. No audio is kept.

## API shapes the dashboard uses

The gateway is the source of truth: `lib/anonymo/types.ts` mirrors its routes field for field and names the file behind
each type, and `lib/anonymo/client.ts` holds every path (`API_PATHS`). The gateway sends USD as numbers (`*_usd`) or, on
receipts, decimal strings; the dashboard computes in integer micro-USD (`lib/anonymo/money.ts`).

| Call | Shape | Gateway file |
| --- | --- | --- |
| `POST /keys` | body `{caps?: {daily_usd, …}}` → `{key, key_hash, wallet, caps, deposit}`; `key` is shown once | `anonymo/keys/routes.ts` |
| `GET /keys/me` | `{key_hash, label, caps, deposit}` | `anonymo/keys/routes.ts` |
| `GET /deposits` | `{instructions: {paused, evm: {key_commit, method, chains[{chain, router, confirmations, tokens[]}]}, solana, tron, btc, coin?, stablecoins_credit}, data[{ref, chain, token, amount_usd, from, status, created_at, reason?}]}` | `anonymo/deposits/routes.ts`, `instructions.ts` |
| `POST /deposits/btcpay` | `{amount_usd, refund_address}` → `{invoice_id, checkout_link, amount_usd, refund}` | `anonymo/deposits/routes.ts` |
| `GET /balance` | `{balance_usd, held_usd, available_usd, usage_only_usd?, withdraw_to[{chain, address, max_usd}]}` | `anonymo/deposits/routes.ts` |
| `POST /withdraw` | header `Idempotency-Key`; `{chain, to, token?, amount_usd?: "all" \| "12.5"}` → `{withdrawal, replay}`; `to` must be one of `withdraw_to` | `anonymo/deposits/withdraw.ts` |
| `GET /withdrawals` | `{data: [{id, status, chain, token, to, amount_usd, tx, created_at, sent_at}]}` | `anonymo/deposits/routes.ts` |
| `POST /v1/chat/completions` | SSE for every model but `anonymo-council`; the last event carries `anonymo_receipt {payload, sig, key_id, alg, leaf, header}`. `anonymo-council` is one JSON body (`stream: false`) with `council {mode, outcome, selected, proposers[{label, model, provider, family, status, cost, receipt_id}], aggregator \| judge, premium, total_cost}`; the mode goes in the body as `council.mode`. Request headers `x-anonymo-refusal-catch`, `x-anonymo-sealed: required` | `api/chat.ts`, `api/council.ts` |
| `GET /v1/models` | `{data: [{id, …, family, quant, weights_hash, attested, refusal_rate_30d}]}` | `api/models.ts`, `anonymo/trust/stats.ts` |
| `GET /v1/receipts/{id}` | `{data: {id, receipt, sig, key_id, alg, leaf, header, signature_valid, keys, anchor}}`; `receipt` is `anonymo-receipt/1` with `routes[{route, role, status, cost, …}]` | `anonymo/trust/routes.ts`, `receipts/anonymo.ts` |
| `GET /v1/receipts/{id}/proof` | `{data: {rooted: false, status: "pending", hint}}` until the hour is rooted, then `{data: {rooted: true, hour, root, leaf, leaf_index, leaf_count, proof[], status, posted, tx_hash, valid}}` | `receipts/roots.ts` |
| `GET /manifest` | `{generated_at, counts, notes[], models[{id, family, quant, weights_hash, attested, refusal_rate_30d, routes[{route, upstream, family, quant, weights_hash, attested, tee, attestation_hash, attested_at}]}]}` | `anonymo/trust/routes.ts` |
| `GET /leaderboard` | `{generated_at, window_days, available, routes[{route, model, family, total_30d, refused_30d, refusal_rate_30d}], families[…]}` | `anonymo/trust/routes.ts` |
| `POST /api/v1/characters` | private card: `{visibility: "private", sealed_card, card_hash}`, sealed on the device with `lib/anonymo/card.ts` | `api/characters.ts` |

Errors are `{error: {code: <HTTP status>, type: <machine code>, message, metadata?}}`. The UI explains `451 floor_blocked`,
`409 sealed_unavailable`, `402`, `401` and `429` without ever echoing the prompt.

## Copy rules (Overview §10), checked by `scripts/check-copy.mjs`

Say "no refusals for legal adult use". Never the phrases "no rules", "anything goes" or "unfiltered". The Venice badge
is the only Venice mention, behind its flag. No profit or investment language about $ANMO. "Fully private" only for
`anonymo-sealed` with its attestation; everything else is "zero retention", a policy. Adults only on every surface,
with an 18+ notice on entry.

## Layout

| Path | What |
| --- | --- |
| `app/` | Landing, `/dashboard` (overview) and `/dashboard/*` (chat, key, funds, receipts, characters, presets), public `/docs`, `/presets`, `/manifest`, `/leaderboard` |
| `components/dashboard/` | Workspace shell (sidebar and top bar), overview, chat thread, answer card and council compare, panels |
| `lib/anonymo/` | Typed client, types, mock gateway, money, presets, proof check, device storage, character cards |
| `lib/guards/`, `components/dashboard/use-content-guard.ts` | Kept from Conclave: warns before a seed phrase, private key or API key is sent in a prompt |
| `server/solana/`, `lib/solana/` | Kept only as the reference WS05 ports the Solana USDC deposit verifier from, and because CI runs `scripts/check-solana.mjs` on it. Nothing in the app imports it; delete it with WS05's port and drop the CI step then. |
