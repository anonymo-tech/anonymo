# Anonymo gateway

The Anonymo router: an OpenAI-compatible API (`/v1/*` and `/api/v1/*`) that routes chat, completions, embeddings and
media requests to open-weight model upstreams, runs the floor gate on every prompt, retries refusals on another model
family, and signs a receipt for every call. Keys are prepaid (`anm_live_…`), funded by stablecoin deposits.

The product spec is in [`../docs/spec`](../docs/spec). The workspace UI is a separate app in [`../dash`](../dash).

## Run it locally

Use **Bun 1.3+**.

```bash
bun install
bun run launch
```

`launch` starts the router against a local pglite database and mock upstreams, creates one key with test credit and
prints it. Test credit has no monetary value. State stays in the ignored `.data/` directory; Ctrl-C stops it.

## Use it from your client

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.ANONYMO_BASE_URL, // your router origin + /v1
  apiKey: process.env.ANONYMO_API_KEY,   // anm_live_…
});

const result = await client.chat.completions.create({
  model: "anonymo-1",
  messages: [{ role: "user", content: "Hello, Anonymo." }],
});
```

The router serves its OpenAPI document at `GET /openapi.json` (source: [`docs/openapi.json`](docs/openapi.json)) and
the list of everything it stores at `GET /keep/inventory.json`.

## Layout

| Area | Source |
| :--- | :--- |
| Anonymo features (floor gate, refusal catch, upstreams, deposits, media, trust) | [`src/anonymo`](src/anonymo) |
| API and routing | [`src/api`](src/api) · [`src/router`](src/router) |
| Ledger and payments | [`src/ledger`](src/ledger) · [`src/pay`](src/pay) |
| Receipts and workers | [`src/receipts`](src/receipts) · [`src/services`](src/services) |
| Contracts | [`contracts/src/anonymo`](contracts/src/anonymo) |
| Client SDK | [`packages/client`](packages/client) · [`packages/client-py`](packages/client-py) |
| Integrations (LiteLLM, Vercel AI SDK, SillyTavern, MCP Registry) | [`integrations`](integrations) |

## Checks

```bash
bun run typecheck
bun test --timeout 20000
(cd contracts && forge test --no-match-path 'test/fork/*')
```

## License

Source-available under [PolyForm Noncommercial 1.0.0](LICENSE), except for files with their own license notices. This
code is derived from Anonymo; its notices and third-party licenses are kept in [NOTICE](NOTICE). The SEAL protocol
specification in [`spec/`](spec) is Apache-2.0 ([spec/LICENSE](spec/LICENSE)).
