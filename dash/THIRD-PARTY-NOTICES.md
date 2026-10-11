# Third-party notices

The Conclave website uses the third-party fonts, software and trademarks listed below. Each item is distributed under its own terms, and those terms come from that item's license text, not from this summary. Exact dependency versions are recorded in `pnpm-lock.yaml`.

## Fonts

| Font | Used for | Copyright | License | License text |
| --- | --- | --- | --- | --- |
| Caveat Brush | Section and page headings | © 2015 Google Inc. | SIL Open Font License 1.1 | `public/fonts/CaveatBrush-LICENSE.txt` |
| Geist | Interface motion and banner labels | © 2023 Vercel, in collaboration with basement.studio | SIL Open Font License 1.1 | `public/fonts/Geist-LICENSE.txt` |
| Instrument Serif | Serif accents and fallback | © 2022 The Instrument Serif Project Authors | SIL Open Font License 1.1 | `public/fonts/InstrumentSerif-LICENSE.txt` and the `@fontsource/instrument-serif` package |
| JetBrains Mono | Technical labels | © 2020 The JetBrains Mono Project Authors | SIL Open Font License 1.1 | `public/fonts/JetBrainsMono-LICENSE.txt` |
| Anton | Fallback display face | © 2020 The Anton Project Authors | SIL Open Font License 1.1 | `public/fonts/Anton-LICENSE.txt` |

Caveat Brush and Geist are stored in `public/fonts/`. The other fonts are installed from npm through [Fontsource](https://fontsource.org/) and bundled into the build output. Each font's full OFL text is also included in `public/fonts/`, so it accompanies production builds. The license includes redistribution and reserved-name terms and is also available at <https://openfontlicense.org>.

The Conclave wordmark is fixed vector artwork. The font software used for the original lettering is not included.

## Software

These packages, and the dependencies they pull in, ship in the browser bundle or in the Worker:

| Package | Version | License | Copyright |
| --- | --- | --- | --- |
| `react`, `react-dom`, `react-server-dom-webpack`, `scheduler` | 19.2.6 (`scheduler` 0.27.0) | MIT | © Meta Platforms, Inc. and affiliates |
| `vinext` | 1.0.0-beta.5 | MIT | © 2026 Cloudflare, Inc. |
| `shaders` | 4.0.0 | MIT | © 2026 Shader Effects Inc. |
| `three` | 0.186.1 | MIT | © 2010–2026 three.js authors |
| `typegpu`, `tinyest` (used by `shaders`) | 0.12.3, 0.3.4 | MIT | © 2025 Software Mansion |
| `typed-binary` (used by `typegpu`) | 4.3.3 | MIT | © 2022 Iwo Plaza |
| `tsover-runtime` (used by `typegpu`) | 0.0.7 | Apache-2.0 | Software Mansion ([source](https://github.com/software-mansion/tsover)) |
| `@xyflow/react`, `@xyflow/system` | 12.12.0, 0.0.83 | MIT | © 2019–2025 webkid GmbH |
| `lucide-react` | 1.31.0 | ISC. Some icons are derived from Feather, which is MIT-licensed (© 2013-present Cole Bemis) | © 2026 Lucide Icons and Contributors |
| `@fontsource/anton`, `@fontsource/instrument-serif`, `@fontsource/jetbrains-mono` | 5.3.0 | SIL Open Font License 1.1 | See [Fonts](#fonts) |

The dashboard's three-dimensional icons use Three.js. Its full MIT license accompanies the app at `public/licenses/three-LICENSE.txt`.

The separate Node media worker uses `sharp` 0.35.5 (Apache-2.0) and its packaged native dependencies. Their license files accompany the installed packages. FFmpeg and FFprobe are separately installed worker tools; their applicable licenses depend on the selected build and codecs. These native tools are not part of the browser bundle.

Passkey registration and authentication use `@simplewebauthn/browser` 14.0.0 and `@simplewebauthn/server` 14.0.3 under the MIT license, copyright © 2020 Matthew Miller. The full license accompanies the app at `public/licenses/simplewebauthn-LICENSE.txt`.

These build and development tools run only on the developer's machine and are not shipped with the site: Vite, `@vitejs/plugin-react` and `@vitejs/plugin-rsc` (MIT), `@cloudflare/vite-plugin` (MIT), Wrangler (MIT or Apache-2.0), Tailwind CSS (MIT), TypeScript (Apache-2.0), `@types/three` (MIT), Oxlint and Oxfmt (MIT). Each one's license file is in its own package under `node_modules` after you run `pnpm install`.

## Trademarks

The site displays the marks and names of Claude (Anthropic), GPT and OpenAI (OpenAI), Gemini (Google), DeepSeek, Qwen (Alibaba Cloud), Llama and Meta (Meta Platforms) and Solana (Solana Foundation). These marks belong to their owners. They appear only to identify model families in the workspace preview and the ecosystem Conclave is designed for. They do not imply any affiliation with, endorsement by or partnership with those owners. They also do not mean that the preview is connected to any of their services.

The logo files in `public/brand/providers/` are the owners' published marks. The site changes only their color and outline. They are not licensed by Conclave, and reuse is subject to each owner's brand guidelines.

Other product names mentioned on the site, such as USDC, Squads, Telegram, Claude Code, Cursor, Windsurf, Cline, Continue, Android and iOS, belong to their respective owners.

### React Flow

The interactive conversation canvas uses React Flow. The full license accompanies the app at `public/licenses/react-flow-LICENSE.txt`.

## Additional Studio marks

Runway and Kling SVG assets are distributed from `@lobehub/icons-static-svg` 1.95.1 under the MIT license, reproduced in `public/licenses/lobe-icons-LICENSE.txt`. Their names and marks remain the property of their respective owners; their display does not imply affiliation or endorsement.
