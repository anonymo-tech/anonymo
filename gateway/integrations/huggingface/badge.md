[![Run on Anonymo](https://img.shields.io/badge/Run%20on-Anonymo-1fe15a?labelColor=0b0c0b)](https://api-production-70da.up.railway.app/models)

### Run it on Anonymo

OpenAI-compatible, pay per call, a signed receipt for every request:

```sh
curl https://api-production-70da.up.railway.app/api/v1/chat/completions \
  -H "Authorization: Bearer $ANONYMO_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"<model id>","messages":[{"role":"user","content":"Hello"}]}'
```

<!-- Only for models with attested endpoints (attested_available: true in GET /api/v1/models): -->
[![Attested on Anonymo](https://img.shields.io/badge/Anonymo-attested%20TEE-1fe15a?labelColor=0b0c0b)](https://api-production-70da.up.railway.app/verify)

Add `"provider": {"lane": "attested"}` to the request to use only providers whose enclave the router verified; it refuses rather than falls back.
