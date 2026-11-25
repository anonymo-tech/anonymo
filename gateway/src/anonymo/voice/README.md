# Mo Voice

Enable the gateway with `ANONYMO_FEATURE_MO_VOICE=true` and the dashboard with `NEXT_PUBLIC_ANONYMO_UPDATES=movoice`. Apply migration 0069 first. Calls use the existing Whisper Large V3 transcription adapter and the Kokoro or Qwen3 speech worker. Configure `ANONYMO_NANOGPT_API_KEY` for transcription and `ANONYMO_TTS_URL` with its optional `ANONYMO_TTS_TOKEN` for stock speech. Deploy inference with the ordinary floor, refusal, and region policy enabled. Worker deployments must discard inputs and outputs after inference.

The dashboard connects via WebSocket. The authenticated session endpoint returns a one-use ticket for the WebSocket subprotocol. Forward the upgrade and pin the session endpoint and its upgrade to the same gateway instance. Preview and save also need the same gateway instance until the preview expires. Microphone frames are 20 ms of mono PCM16LE at 48 kHz. VAD forwards voiced segments to the existing file-based STT adapter, which yields partial captions between segments. Speech comes back as individual WAV messages. The call times out after 15 minutes. A graceful hangup returns signed usage and route metadata.

`POST /v1/voice/sessions` also accepts `{"transport":"livekit"}` when `ANONYMO_LIVEKIT_URL`, `ANONYMO_LIVEKIT_KEY` and `ANONYMO_LIVEKIT_SECRET` are set. It mints a short-lived microphone-only join grant for a new room. The SFU media bridge and participant client are deployment work. The gateway currently serves calls over WebSocket.

For design, set `ANONYMO_VOICE_DESIGN_URL` and optionally `ANONYMO_VOICE_DESIGN_TOKEN` for a private Qwen3 worker. The worker contract uses a consistent, calibrated speaker space for every vector.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /v1/voices/stock-embeddings` | Empty | JSON mapping each `kokoro:<id>` and `qwen3-tts:<id>` in the stock catalog to a float vector |
| `POST /v1/voices/design` | JSON with `model` and normalized text `description` | JSON with the generated `embedding` float vector |
| `POST /v1/voices/speech` | JSON with `model`, `input`, server-selected `embedding` and `response_format` | 16-bit PCM WAV |

The gateway refuses designs at cosine similarity 0.90 or above. Calibrate the worker and stock registry using the deployed models before launch. The worker receives no reference audio. Stock and designed call speech settles at $1.80 per hour of generated audio. Transcription is prorated by received samples sent for transcription. Chat retains its ordinary charges and zero-charge refusal behavior.
