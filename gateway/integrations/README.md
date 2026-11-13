# Integrations

Ready-to-submit listings of Anonymo in the tools people already use. Each folder has a README with the exact steps to use it today and to submit it. **Nothing here has been published or submitted yet.**

| Folder | Where it lists Anonymo | What is in it | Works today without submitting |
| --- | --- | --- | --- |
| [`litellm/`](litellm/) | LiteLLM (proxy and SDK) | cost-map entries for 358 models, provider registration, sample `config.yaml` | yes, via `config.yaml` |
| [`vercel-ai-sdk/`](vercel-ai-sdk/) | Vercel AI SDK community providers | `@anonymo/ai-sdk-provider` package (receipt and cost in `providerMetadata`, attested lane option) | after `npm publish` |
| [`sillytavern/`](sillytavern/) | SillyTavern "Custom (OpenAI-compatible)" | connection recipe, importable preset | yes |
| [`mcp-registry/`](mcp-registry/) | Official MCP Registry | `server.json` for `io.github.anonymo-tech/anonymo` (the existing `/mcp` server) | yes, via `claude mcp add` |

Use `https://anonymo.tech/api/v1` for inference and `https://anonymo.tech/mcp` for MCP. Before submitting a listing, review its endpoint and publication status. The client SDK code is in `packages/client` and `packages/client-py`; npm and PyPI releases are not published yet.

## Regenerate from the live catalogue

```sh
bun scripts/gen-integrations.ts
```

Rewrites `litellm/` from `GET /api/v1/models` (public, no key). The catalogue generator has validation in the repository.

The two TypeScript packages have their own `package.json` and are not part of the router's build or typecheck:

```sh
cd integrations/vercel-ai-sdk && bun install && bun run typecheck
cd integrations/elizaos && bun install && bun run typecheck
```

Both packages are Apache-2.0, like the client SDK in `packages/client`.

The official SDKs (TypeScript, Python, Go) and the LangChain and LlamaIndex packages live in [`sdks/`](../sdks/).
