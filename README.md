# Anonymo

One OpenAI-compatible key for uncensored and low-refusal models: text, code, image, video and voice. Refusals of legal requests are rerouted to a different model family and refunded, every call returns a signed receipt, and `anonymo-sealed` runs only on attested enclaves.

The product spec is in [`docs/spec/`](docs/spec/): the Overview and the Backend PDFs. **Start with [HANDOFF.md](HANDOFF.md)**, which splits the build into parallel workstreams.

## What's in this repo

| Path | What it is | Came from |
|---|---|---|
| [`gateway/`](gateway/) | The API: router, ledger, receipts, attestation, council, `/v1/messages`, MCP, x402, character cards, contracts. Bun · Hono · tRPC · Drizzle · Postgres · Redis · viem · Foundry | Anonymo (`main` @ `31f13a31`), tracked files only |
| [`dash/`](dash/) | The web workspace. Its layout is the base for the Anonymo dashboard; it also has a working Solana USDC deposit server (`dash/server/solana`) | Conclave (`main` @ `0cf3781`), tracked files only |
| [`port/anonyma/`](port/anonyma/) | Reference code to port, not wired in: image, speech and video endpoints, media storage, the support inbox, and their tests (Node/Express/SQLite) | Anonyma-backend |
| [`docs/spec/`](docs/spec/) | The product and backend specs | — |

Everything is still branded and wired as its source project. Turning it into Anonymo is the work described in HANDOFF.md.

## Run it

```bash
cd gateway && bun install && bun run launch   # dev chain, contracts, mock providers, API
```

```bash
cd dash && pnpm install && pnpm dev           # workspace UI (pnpm 11.19, Node 22.13+)
```

## Licensing

`gateway/` carries the PolyForm Noncommercial license and `dash/` carries its own LICENSE from the source projects. Decide Anonymo's license and relicense before any commercial launch.
