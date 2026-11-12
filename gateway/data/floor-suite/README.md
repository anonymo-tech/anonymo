# Floor suite

The floor gate is tested in CI against labelled prompt sets (Backend §10): every red-team prompt must be blocked
under its category, and no adult-legal prompt may be blocked. The harness is
[`src/anonymo/floor/suite.ts`](../../src/anonymo/floor/suite.ts); the tests are in [`test/floor/`](../../test/floor/).

## The hard rule

**No red-team text in this repository, ever.** That means no sexual content involving minors, no sexualised content
about real, identifiable people and no real weapons-uplift instructions, in any file and in any form (fixtures,
comments, commit messages, CI logs, issues, PR descriptions), even as test data.

What may live here:

| File | Contents |
|---|---|
| `manifest.json` | One entry per set: name, label, category, file name, where it lives, item count and SHA-256 of the file. |
| `adult-legal.jsonl` | Benign adult-legal prompts: dark fiction, adult romance requests, sexual health, harm reduction, medical, security research, and near-misses that look close to a line but are not (history, law, defence). |
| `placeholders.jsonl` | `FLOOR-PLACEHOLDER:<category>` strings. They contain nothing harmful; the test double recognises the marker, so they exercise the gate's plumbing (HTTP client, prompt format, strict parser, 451 path) without real red-team text. |

The real red-team sets live in an access-controlled directory outside git, named by `FLOOR_SUITE_DIR`.

## File format

JSON Lines, one prompt per line: `{"id": "rt-cbrn-001", "category": "cbrn", "text": "..."}`. `category` is one of
`minor`, `real_person`, `voice_clone`, `cbrn`, and is optional in adult-legal sets. Ids are unique within a file.

## Running

```bash
bun test test/floor/                                  # in-repo sets against the pre-filter and the test double
FLOOR_SUITE_DIR=/secure/floor-suite \
ANONYMO_FLOOR_URL=https://guard.internal/v1 ANONYMO_FLOOR_MODEL=llama-guard-3-1b ANONYMO_FLOOR_KEY=... \
FLOOR_SUITE_REQUIRED=1 bun test test/floor/suite.test.ts   # every set against the real guard model
```

Without `FLOOR_SUITE_DIR` the external sets are skipped; with `FLOOR_SUITE_REQUIRED=1` a missing set fails the run.
With `FLOOR_SUITE_DIR` set, `ANONYMO_FLOOR_URL` is required: red-team sets mean nothing against the test double.
Results and failures list item ids and counts only, never prompt text, so CI logs stay clean.

The run against the real guard model belongs in a protected CI job (manual or nightly, trusted runner, environment
secrets): the job fetches the encrypted archive, decrypts it into a temporary directory, runs the suite with the
variables above, and deletes the directory. Pull requests from forks never get the secrets.

## Sourcing vetted datasets

Each external set is owned by the trust-and-safety reviewers, not by whoever writes code. The process:

1. **Source.** Prefer published, access-gated research sets and pull only *request* prompts, never model completions.
   Candidates per category (check each licence and terms of use before use; access and licences are unverified here):
   - `cbrn`: the chemical/biological and explosives subsets of HarmBench, SORRY-Bench, AIR-Bench and StrongREJECT.
     Do not use WMDP's question bank as red-team prompts: it measures knowledge, not requests for uplift.
   - `real_person` and `voice_clone`: requests written by trained reviewers against a fixed list of public figures,
     plus the relevant subsets of the benchmarks above. The prompts are requests only; no generated output is kept.
   - `minor`: only from a vetted child-safety partner or vendor under contract, or written in-house by trained
     reviewers as *requests* under counsel's guidance. Never collect, generate or store imagery, and never keep model
     output for this category.
   - Adult-legal (`adult-legal-extended`): XSTest's safe prompts, an OR-Bench-Hard sample, and adult-content requests
     written in-house (explicit fiction between adults, kink with negotiated consent, sexual health).
2. **Vet.** Two reviewers label every item independently; disagreements are dropped, not argued in. Remove duplicates
   and anything that is not clearly in its label.
3. **Pin.** Run `bun src/anonymo/floor/suite.ts pin <dir>` and copy the `count` and `sha256` into `manifest.json` in a
   PR. The PR carries hashes and counts only. A set whose hash does not match the manifest fails the run.
4. **Store.** Keep the files in an encrypted archive in a private bucket that only the reviewers and the protected CI
   job can read. Rotate the decryption key when a reviewer leaves. Never copy the files into a worktree or a ticket.
5. **Refresh.** Add new red-team items when a miss is found in production (from a reported floor hit's category and
   the reviewer's rewrite, never from a user's prompt). Re-pin and keep the counts in the manifest current.

The spec targets 400 red-team prompts (100 per category) and 400 adult-legal prompts. The manifest lists those sets
with `sha256: null` until they are sourced and pinned.
