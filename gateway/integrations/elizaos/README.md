# @anonymo/plugin-anonymo (ElizaOS)

A model provider for [ElizaOS](https://elizaos.ai) agents. It registers `TEXT_SMALL`, `TEXT_LARGE` and `TEXT_EMBEDDING` against Anonymo, so an agent can use any catalogue model by id and pay per call from one key.

What it adds for agents: with `ANONYMO_LANE=attested` every model call goes only to providers whose TEE enclave the router has verified, and the router refuses (sending nothing, charging nothing) when none can answer, so an agent never silently falls back to an unattested host. Each answer carries a signed receipt id, logged at debug level.

## Use

```sh
bun add @anonymo/plugin-anonymo
```

```ts
import anonymoPlugin from "@anonymo/plugin-anonymo";

export const character = {
  name: "Agent",
  plugins: ["@anonymo/plugin-anonymo"], // or pass anonymoPlugin in a project's plugins list
  settings: { secrets: { ANONYMO_API_KEY: process.env.ANONYMO_API_KEY } },
};
```

| Setting | Default |
| --- | --- |
| `ANONYMO_API_KEY` | required |
| `ANONYMO_BASE_URL` | `https://api-production-70da.up.railway.app/api/v1` |
| `ANONYMO_SMALL_MODEL` | `meta-llama/llama-3.3-70b-instruct` |
| `ANONYMO_LARGE_MODEL` | `deepseek/deepseek-v3.2` |
| `ANONYMO_EMBEDDING_MODEL` | `qwen/qwen3-embedding-8b` |
| `ANONYMO_EMBEDDING_DIMENSIONS` | `4096` |
| `ANONYMO_LANE` | `public` (set `attested` for enclave-only) |

All three default models have attested endpoints, so `ANONYMO_LANE=attested` works without changing them. For other attested models, see `list_attested_models` on the MCP server or `attested_available: true` in `GET /api/v1/models`.

## Status

A skeleton: text and embeddings only, no streaming, no image or object models yet. It typechecks against `@elizaos/core` 1.7:

```sh
cd integrations/elizaos && bun install && bun run typecheck
```

## Publish and list (not done yet)

1. `bun run build`, then `npm publish --access public` (needs the `@anonymo` npm scope). ElizaOS expects plugin repos named `plugin-<name>`; mirror this folder to `anonymo-tech/plugin-anonymo` if the registry asks for a standalone repo.
2. Open a PR on `elizaos-plugins/registry` adding `"@anonymo/plugin-anonymo": "github:anonymo-tech/plugin-anonymo"` to `index.json`.

License: Apache-2.0.
