# Renamed from Anonymo (WS01)

The router was forked from Anonymo. This release renames everything a client or an operator sets or reads. The old
names below still work **for this release only** and are removed in the next one. Nothing else needs to change.

## Kept for one release, then removed

| Old | New | How the old one is handled now |
| :--- | :--- | :--- |
| Request headers `x-anonymo-*` (lane, disclosure-max, lane-downgrade, cache, json-check, sealed, refusal-catch, …) | `x-anonymo-*` | Read as the `x-anonymo-*` header of the same name; the new header wins when both are sent. The response carries `Warning: 299 - "x-anonymo-* request headers are deprecated …"`. |
| Settings `ANONYMO_*` (`ANONYMO_ENV`, `ANONYMO_FEATURE_COUNCIL`, `ANONYMO_COUNCIL_*`) | `ANONYMO_*` | Read as the `ANONYMO_*` setting; the new name wins. The router logs `deprecated setting name` once per old name at start. |
| Request option `anonymo: { json_check }` (chat body and presets) | `anonymo: { json_check }` | Read as `anonymo`. |
| `/.well-known/anonymo-receipt-keys.json` | `/.well-known/anonymo-receipt-keys.json` | Same document on both paths. |
| Client SDK `Anonymo`, `AnonymoError`, `AnonymoMeta`, `result.anonymo` | `Anonymo`, `AnonymoError`, `AnonymoMeta`, `result.anonymo` | Deprecated aliases of the new names. |
| X-Wallet-Auth signed message `anonymo:<ts>:<bodySha>` | `anonymo:<ts>:<bodySha>` | Either signature verifies; one timestamp and body authorize one call whichever prefix signed it. |
| Creator-claim proof file `anonymo.json` | `anonymo.json` | Read when `anonymo.json` is missing. |
| Day-zero claim file `anonymo-claim.txt` | `anonymo-claim.txt` (`LANE_CLAIM_FILE`) | Read when the new file is missing (default file name only). New challenges start `anonymo-claim-`; challenges already issued keep their text. |
| Facilitator listing EIP-712 domain `Anonymo Facilitator` | `Anonymo Facilitator` | Listings signed under the old domain are accepted (they are checked only when submitted). |
| Stream chain comment `: anonymo-chain <i> <hex>` | `: anonymo-chain <i> <hex>` | The router sends the new label; the client SDK reads both. The label is not part of the chain. |

## Renamed without an alias

These are only ever sent by the router, so there is nothing to alias:

- Response headers are `x-anonymo-*` (for example `x-anonymo-lane`, `x-anonymo-policy-hash`, `x-anonymo-disclosure`,
  `x-anonymo-cache`, `x-anonymo-route`, `x-anonymo-ignored`, `x-anonymo-character*`, `x-anonymo-card-hash`).
- Webhook deliveries carry `x-anonymo-event-id` and `x-anonymo-signature`.
- The Anthropic-compatible endpoint returns its router details under `anonymo` (was `anonymo`); the Responses endpoint
  returns `anonymo_receipt_id`, `anonymo_lane`, `anonymo_disclosure` and `anonymo_policy_hash`.
- Streams send `: ANONYMO PROCESSING` keep-alive comments.
- Tracing exports use `anonymo.*` attributes and service name `anonymo`; Helicone properties are `Anonymo-*`.
- New API keys start with `anm_live_`. Keys that start with `sk-ar-v1-` keep working: the secret derivation is unchanged.
- The model id `anonymo/council` is retired: it answers 404 `model_not_found` with a message naming `anonymo-council`,
  which takes `council.models`, `council.judge` and `council.mode` for an explicit council.
- The client package is `@anonymo/client`; the Vercel AI SDK provider is `@anonymo/ai-sdk-provider` (export `anonymo`).
- Operators: the Prometheus metrics are `anonymo_ready`, `anonymo_readiness_check`, `anonymo_readiness_warning` and
  `anonymo_chain_*`; scrape jobs `anonymo` and `anonymo-chain`; alerts `Anonymo*` (for example `AnonymoNotReady`). The
  compose files take `ANONYMO_IMAGE` and set `ANONYMO_ENV`. Update dashboards and silences that use the old names.

## Not renamed, on purpose

Changing these would invalidate keys, signatures or stored data, or break deployed components:

- Cryptographic domain strings: the key derivation (`anonymo-key-v1:`, every existing key depends on it), the
  response-cache key (`anonymo:aes:`), the x402 recovery message, the character-card HKDF/AES-GCM labels (dash uses
  the same ones), and the EIP-712 domain `Anonymo Credits` (compiled into the deployed Anonymo Credits contract,
  which this repository no longer contains, so nothing here could change it in step).
- Signed document types (`anonymo.statement.v1`, `anonymo.lane-report.v1`, `anonymo.data-inventory/1`,
  `anonymo.measurement.bundle`, `anonymo.deployments/v1`): verifiers check these exact strings.
- The attested-host sidecar protocol (`anonymo.sidecar.*` report types, its `x-anonymo-receipt*` response headers,
  the `attest.anonymo` certificate name).
- Operator internals that hold state: database role names (`anonymo_runtime`), BullMQ queue names, the backup object
  prefix and the worker heartbeat file. Renaming them needs a coordinated migration of a running deployment.
- The publish-guard hook's pinned contributor identity (`.githooks/publish-guard.sh`, CONTRIBUTING.md).
