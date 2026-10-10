# Conclave

**See what one model misses.**

Conclave is a multi-model AI workspace built for Solana. Compare perspectives,
keep conversations in projects, and review usage before committing to a request.

The application source lives in `web/`. It includes the interface, model routing,
account authentication, payment accounting, and receipt verification.

See [LICENSE](LICENSE) for source terms and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for dependency notices.

For live inference, configure `GATEWAY_API_KEY`, `GATEWAY_API_ORIGIN` and
`GATEWAY_EVIDENCE_ORIGINS` on the server. The API origin must be HTTPS; the evidence
setting is a JSON array of exact HTTPS origins used to review provider policies.
No provider endpoint or credential is bundled. Requests pass through the configured
inference gateway and upstream model provider; standard mode is not end-to-end encrypted.
