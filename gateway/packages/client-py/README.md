# anonymo-client

A small Python client for the Anonymo router: chat calls whose signed receipt is checked against the router's
published keys, and verify-before-send for attested providers. The SDK code is in this repository; a PyPI release is
not published yet.

```python
from anonymo_client import Anonymo

with Anonymo(router_url, api_key) as client:  # api_key: anm_live_…
    res = client.chat({"model": "anonymo-1", "messages": [{"role": "user", "content": "Hello"}], "max_tokens": 32})
    print(res["choices"][0]["message"]["content"])
    print(res["anonymo"]["receipt_verification"].valid, res["anonymo"]["disclosure"])
```

`verify_receipt`, `fetch_receipt_keys` and `verify_provider` are also available on their own. Errors are
`AnonymoError` (with `AttestationRefused` and `ReceiptInvalid`). `Anonymo`, `AnonymoError` and `res["anonymo"]`
are deprecated aliases from before the rebrand and are removed in the next release.
