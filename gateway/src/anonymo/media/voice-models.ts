export const KOKORO_ID = "kokoro/kokoro-82m";
export const WHISPER_ID = "openai/whisper-large-v3";
export const KOKORO_MAX_CHARS = 10_000;
export const TRANSCRIPTION_MAX_BYTES = 4_000_000;
export const TRANSCRIPTION_MAX_SECONDS = 300;

export const NANOGPT_KOKORO_VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
];

export const TRANSCRIPTION_FORMATS = {
  mp3: { demuxer: "mp3", mime: "audio/mpeg" },
  ogg: { demuxer: "ogg", mime: "audio/ogg" },
  wav: { demuxer: "wav", mime: "audio/wav" },
  m4a: { demuxer: "mov", mime: "audio/mp4" },
  aac: { demuxer: "aac", mime: "audio/aac" },
} as const;
export type TranscriptionFormat = keyof typeof TRANSCRIPTION_FORMATS;
