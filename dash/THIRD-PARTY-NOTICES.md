# Third-party notices

The Anonymo dashboard uses the third-party fonts and software listed below. Each item is distributed under its own terms, and those terms come from that item's license text, not from this summary. Exact versions are recorded in `pnpm-lock.yaml`.

## Fonts

| Font | Used for | License | License text |
| --- | --- | --- | --- |
| IBM Plex Sans | Interface and reading text | SIL Open Font License 1.1 | `@fontsource/ibm-plex-sans/LICENSE` |
| IBM Plex Mono | Wordmark, keys, amounts and hashes | SIL Open Font License 1.1 | `@fontsource/ibm-plex-mono/LICENSE` |

Both are installed from npm through [Fontsource](https://fontsource.org/) and bundled into the build output. "Plex" is a reserved font name of IBM Corp.

## Software shipped in the browser bundle

| Package | License |
| --- | --- |
| `react`, `react-dom`, `react-server-dom-webpack` | MIT, © Meta Platforms, Inc. and affiliates |
| `vinext` | MIT, © Cloudflare, Inc. |
| `lucide-react` | ISC, © Lucide Icons and Contributors; some icons derive from Feather (MIT) |
| `pdfjs-dist` (Paper Trail PDF reading) | Apache-2.0, © Mozilla Foundation; full text in `pdfjs-dist/LICENSE` |
| `@noble/hashes`, `@noble/curves` | MIT, © Paul Miller |
| `@scure/bip39` (seed-phrase detection in the composer) | MIT, © Paul Miller |
| `bs58` | MIT |

`lib/anonymo/card.ts` is a copy of `gateway/src/characters/card.ts` from this repository.

Build and development tools run only on the developer's machine: Vite, `@vitejs/plugin-react`, `@vitejs/plugin-rsc` (MIT), TypeScript (Apache-2.0), `fast-check` (MIT), Oxlint and Oxfmt (MIT).

## Trademarks

Model family names (DeepSeek, GLM, Qwen, Gemma, Mistral, Kimi, Llama) and upstream names (Venice, Phala, Chutes, NanoGPT, Featherless) identify where a route runs. They belong to their owners and do not imply endorsement. "Built in Venice" is shown only behind `NEXT_PUBLIC_ANONYMO_VENICE_BADGE=1`, following Venice's badge terms.
