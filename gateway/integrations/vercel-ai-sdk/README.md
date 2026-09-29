# @anonymo/ai-sdk-provider

Anonymo for the [Vercel AI SDK](https://ai-sdk.dev). 350+ models behind one key, a signed receipt on every call, and an attested-only lane. Built on the SDK's own `@ai-sdk/openai-compatible`, so chat, streaming, tools, structured output and embeddings work as with any OpenAI-compatible provider.

```sh
npm i @anonymo/ai-sdk-provider ai
export ANONYMO_API_KEY=sk-ar-v1-...
```

```ts
import { generateText } from "ai";
import { anonymo } from "@anonymo/ai-sdk-provider";

const { text, providerMetadata } = await generateText({
  model: anonymo("meta-llama/llama-3.3-70b-instruct"),
  prompt: "Say hello in five words.",
});
console.log(providerMetadata?.anonymo); // { receiptId, receiptKeyId, costUsd }
```

Any id from `GET /api/v1/models` works as the model. Embeddings: `anonymo.embeddingModel("qwen/qwen3-embedding-8b")`. More in `examples/generate.ts`.

## Options

```ts
import { createAnonymo } from "@anonymo/ai-sdk-provider";

const attested = createAnonymo({
  lane: "attested",          // only providers whose enclave the router verified; refuses rather than falls back
  apiKey: "sk-ar-v1-...",    // default: ANONYMO_API_KEY, read when a request is sent
  baseURL: "https://.../api/v1", // default: ANONYMO_BASE_URL, then the public router
});
```

`providerMetadata.anonymo.receiptId` is the id of the Ed25519-signed receipt for the call. Check it with `GET /api/v1/receipts/<id>` or `POST /api/v1/receipts/verify`.

## Develop

```sh
cd integrations/vercel-ai-sdk
bun install          # or npm install
npm run typecheck    # tsc --noEmit
npm run build        # emits dist/
```

## Publish and list (not done yet)

1. `npm run build`, then `npm publish --access public` from this folder (needs the `@anonymo` npm scope).
2. Ask to be listed as a community provider: open a PR on `vercel/ai` adding `content/providers/03-community-providers/<nn>-anonymo.mdx` (install, setup, the example above), following the format of the neighbouring community provider pages.

License: Apache-2.0.
