# @anonymo/client

A small client for the Anonymo router: OpenAI-shaped chat calls, plus the checks the router makes possible. Every
response's signed receipt is verified against the router's published keys, and you can ask what a call disclosed.
The SDK code is in this repository; an npm release is not published yet.

```ts
import { Anonymo, ReceiptInvalid } from "@anonymo/client";

const client = new Anonymo({ baseUrl: routerUrl, apiKey }); // apiKey: anm_live_…
const res = await client.chat.completions.create({
  model: "anonymo-1",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 32,
});
console.log(res.choices[0].message.content);
console.log(res.anonymo.receiptVerification?.valid, res.anonymo.disclosure, res.anonymo.generationId);
```

- `client.chat.completions.stream(body)` streams, and checks the receipt chain carried in the stream.
- `verifyReceipt`, `verifyReceiptV2` and `fetchReceiptKeys` check a receipt on their own; `privacyLabel` and
  `fetchPrivacyLabel` say who could read a call and what was kept.
- `routingHeaders({ lane: "attested" })` builds the `x-anonymo-lane` and `x-anonymo-disclosure-max` headers, and
  `withRouting(body, { lane: "attested" })` sets the same in the body; `verifyProvider` checks an attested provider's
  hardware attestation.
- `@anonymo/client/characters` encrypts private character cards and memory on your device.

Errors are `AnonymoError` (with `AttestationRefused` and `ReceiptInvalid`). `Anonymo`, `AnonymoError`,

