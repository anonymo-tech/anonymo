# Conclave production source

This branch contains the source deployed at https://conclavemodels.com. Start work from `codex/live-production-source` when you need the current production baseline.

```sh
git clone --branch codex/live-production-source https://github.com/ConclaveSOL/Conclave-private.git
cd Conclave-private
corepack pnpm install --frozen-lockfile
node scripts/verify-production-source.mjs
pnpm typecheck
pnpm check:feature-release
CONCLAVE_DEPLOY_TARGET=node pnpm build
```

Use Node 24 and the package-manager version pinned in package.json. Configure local backing services and environment variables separately; credentials, database contents and wallet keys are not included. `pnpm dev` starts the app, while live service mode also requires the backend runtime configuration.

## Production baseline

- Deployment: `8f56129f-fc8c-4cdd-9fd2-f673cc5d853a`, created October 15, 2026 at 04:31:14 UTC.
- `production-source.json` records the SHA-256 of all 590 uploaded source and asset files. The verification script checks the exact bytes, including feature gates and lockfile.
- Projects, Canvas, Library, Decisions, Help, Model routes, Purse, Receipts, Cross-Check, Brief synthesis, Solana Explainer, Studio, Chapters, Agents and Connections are enabled.
- The grouped searchable picker supports 112 chat options: 107 Chinese models/variants and five existing global options. Up to four may be compared at once. This snapshot includes the expanded catalog and native completion budgets.
- Native chat completion budgets/history, mainnet USDC top-ups, the existing capped wallet welcome campaign and verified Studio formats are preserved.
- The owner-signed flywheel is enabled. Eligible chat platform fee: 5%; reserve share: 50%. Wallet funding and transaction signatures are separate operational steps. Never run the localnet automatic executor on mainnet.
- FOMO / Second Look and token-denominated funding remain disabled.

This is an exact deployed-source baseline, not a merge of every development branch. Runtime configuration and live response verification are recorded separately by each release. In particular, source-only language work remains on the existing branches and is not silently removed from them. The current private `main`, other release branches and the public repository are preserved. Do not merge this snapshot over unrelated work without reconciling those changes.

## Release workflow

1. Branch from the appropriate committed baseline, make changes, and push the reviewed source to this private repository so collaborators can access it.
2. Test the approved feature and preserve all existing release gates. Update the source manifest for a new release candidate; do not claim it is deployed until production verification succeeds.
3. Deploy only an explicitly approved, committed revision. Keep GitHub automatic deployment disabled.
4. Record the deployed commit and deployment identifier after verification. Public repository publication is a separate reviewed operation; it is not needed to share code privately.

The production manifest records code, not runtime secret values or database state. Copying it does not recreate balances, welcome grants, transactions or operational credentials.
