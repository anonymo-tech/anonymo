// One-paste setups for the frontends people already use (Overview §2, Backend M6). Each preset is the list of fields
// the frontend asks for, plus a block to paste where the frontend takes a config file or environment variables.
// The key is filled in only when the person asks for it; by default the snippet carries a placeholder.

export type PresetField = { label: string; value: string; secret?: boolean };
export type Preset = {
  id: string;
  name: string;
  where: string; // where the settings live in that frontend
  defaultModel: string;
  fields: (ctx: PresetContext) => PresetField[];
  snippet?: (ctx: PresetContext) => { language: string; text: string };
  note?: string;
};
export type PresetContext = { base: string; key: string; model: string };

export const KEY_PLACEHOLDER = 'anm_live_YOUR_KEY';

const v1 = (base: string) => `${base}/v1`;
const completions = (base: string) => `${base}/v1/chat/completions`;

export const PRESETS: Preset[] = [
  {
    id: 'janitorai',
    name: 'JanitorAI',
    where: 'API Settings → Proxy',
    defaultModel: 'anonymo-rp',
    fields: ({ base, key, model }) => [
      { label: 'Model', value: model },
      { label: 'Proxy URL', value: completions(base) },
      { label: 'API key', value: key, secret: true },
    ],
    note: 'JanitorAI wants the full chat-completions URL, not the /v1 base.',
  },
  {
    id: 'sillytavern',
    name: 'SillyTavern',
    where: 'API Connections → Chat Completion → Custom (OpenAI-compatible)',
    defaultModel: 'anonymo-rp',
    fields: ({ base, key, model }) => [
      { label: 'Custom endpoint (base URL)', value: v1(base) },
      { label: 'Custom API key', value: key, secret: true },
      { label: 'Model ID', value: model },
    ],
    note: 'Character cards and lorebooks stay in SillyTavern; it sends them as part of the prompt.',
  },
  {
    id: 'chub',
    name: 'Chub',
    where: 'Settings → API → OpenAI-compatible / reverse proxy',
    defaultModel: 'anonymo-rp',
    fields: ({ base, key, model }) => [
      { label: 'Reverse proxy URL', value: v1(base) },
      { label: 'Proxy key', value: key, secret: true },
      { label: 'Model', value: model },
    ],
  },
  {
    id: 'agnai',
    name: 'Agnai',
    where: 'Settings → AI → Third party (format: OpenAI Chat)',
    defaultModel: 'anonymo-rp',
    fields: ({ base, key, model }) => [
      { label: 'Third party URL', value: v1(base) },
      { label: 'Format', value: 'OpenAI (chat completions)' },
      { label: 'Third party password', value: key, secret: true },
      { label: 'Model override', value: model },
    ],
  },
  {
    id: 'openwebui',
    name: 'Open WebUI',
    where: 'Admin Settings → Connections → OpenAI API, or environment variables',
    defaultModel: 'anonymo-1',
    fields: ({ base, key }) => [
      { label: 'API base URL', value: v1(base) },
      { label: 'API key', value: key, secret: true },
    ],
    snippet: ({ base, key }) => ({
      language: 'env',
      text: `OPENAI_API_BASE_URL=${v1(base)}\nOPENAI_API_KEY=${key}`,
    }),
    note: 'Open WebUI lists every Anonymo model from /v1/models once connected.',
  },
  {
    id: 'librechat',
    name: 'LibreChat',
    where: 'librechat.yaml → endpoints.custom',
    defaultModel: 'anonymo-1',
    fields: ({ base }) => [
      { label: 'baseURL', value: v1(base) },
      { label: 'apiKey', value: '${ANONYMO_API_KEY}' },
    ],
    snippet: ({ base, key }) => ({
      language: 'yaml',
      text: [
        'endpoints:',
        '  custom:',
        '    - name: "Anonymo"',
        '      apiKey: "${ANONYMO_API_KEY}"',
        `      baseURL: "${v1(base)}"`,
        '      models:',
        '        default: ["anonymo-1", "anonymo-rp", "anonymo-council", "anonymo-sealed"]',
        '        fetch: true',
        '      titleConvo: true',
        '      titleModel: "anonymo-1"',
        '      modelDisplayLabel: "Anonymo"',
        '',
        `# .env: ANONYMO_API_KEY=${key}`,
      ].join('\n'),
    }),
  },
  {
    id: 'typingmind',
    name: 'TypingMind',
    where: 'Models → Add custom model',
    defaultModel: 'anonymo-1',
    fields: ({ base, key, model }) => [
      { label: 'API type', value: 'OpenAI compatible' },
      { label: 'Endpoint', value: completions(base) },
      { label: 'Model ID', value: model },
      { label: 'Header', value: `Authorization: Bearer ${key}`, secret: true },
      { label: 'Context length', value: '32768' },
    ],
  },
];

/** The text a "Copy setup" button puts on the clipboard: every field, then the snippet. */
export function presetText(preset: Preset, ctx: PresetContext): string {
  const fields = preset.fields(ctx).map((f) => `${f.label}: ${f.value}`);
  const snippet = preset.snippet?.(ctx);
  return [`${preset.name} — ${preset.where}`, ...fields, ...(snippet ? ['', snippet.text] : [])].join('\n');
}
