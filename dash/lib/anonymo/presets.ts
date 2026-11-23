// One-paste setups for the frontends people already use (Overview §2, Backend M6). Each preset is the list of fields
// the frontend asks for, plus a block to paste where the frontend takes a config file or environment variables.
// The key is filled in only when the person asks for it; by default the snippet carries a placeholder.

export type PresetField = { label: string; value: string; secret?: boolean };
export type Preset = {
  id: string;
  name: string;
  where: string; // where the settings live in that frontend
  defaultModel: string;
  /** The models this frontend can use, when not every Anonymo model fits (Codex needs tool calling). */
  models?: string[];
  fields: (ctx: PresetContext) => PresetField[];
  snippet?: (ctx: PresetContext) => { language: string; text: string };
  note?: string;
};
export type PresetContext = { base: string; key: string; model: string };

export const KEY_PLACEHOLDER = 'anm_live_YOUR_KEY';

const v1 = (base: string) => `${base}/v1`;
/** Live models with tool calling and few refusals, for agent frontends that always send tools. */
export const CODEX_MODELS = ['deepseek-v4.1-flash-1017-ultrafast', 'kimi-k3.1-pro-fast', 'glm-5.2-fast'];
const completions = (base: string) => `${base}/v1/chat/completions`;

export const PRESETS: Preset[] = [
  {
    id: 'janitorai',
    name: 'JanitorAI',
    where: 'API Settings → Proxy',
    defaultModel: 'anonymo-1',
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
    defaultModel: 'anonymo-1',
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
    defaultModel: 'anonymo-1',
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
    defaultModel: 'anonymo-1',
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
        '        default: ["anonymo-1", "anonymo-council"]',
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
    id: 'codex',
    name: 'Codex CLI',
    where: '~/.codex/config.toml, with your key in the ANONYMO_API_KEY environment variable',
    defaultModel: CODEX_MODELS[0],
    models: CODEX_MODELS,
    fields: ({ base, model }) => [
      { label: 'Provider base URL', value: v1(base) },
      { label: 'Wire API', value: 'responses' },
      { label: 'Model', value: model },
      { label: 'MCP server (optional)', value: `${base}/mcp` },
    ],
    snippet: ({ base, key, model }) => ({
      language: 'toml',
      text: [
        `model = "${model}"`,
        'model_provider = "anonymo"',
        '',
        '[model_providers.anonymo]',
        'name = "Anonymo"',
        `base_url = "${v1(base)}"`,
        'env_key = "ANONYMO_API_KEY"',
        'wire_api = "responses"',
        '',
        '# Optional: Anonymo as a tool inside Codex, for anonymo-1 and the council.',
        '[mcp_servers.anonymo]',
        `url = "${base}/mcp"`,
        'bearer_token_env_var = "ANONYMO_API_KEY"',
        '',
        `# In your shell: export ANONYMO_API_KEY=${key}`,
      ].join('\n'),
    }),
    note: 'Codex sends tools (shell, file edits) with every request, so it needs a model that supports tool calling: these do. anonymo-1 does not yet, but through the MCP server Codex can still ask it as a tool.',
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

// ---- Update 05: coding tools over MCP ----------------------------------------------------------------------------
// Cursor and Claude Code connect to the gateway's MCP server (POST /mcp, Streamable HTTP, JSON replies). Both read the
// key from the ANONYMO_API_KEY environment variable when they start, so the saved config holds only a reference to
// it: nothing here ever contains a key, and every snippet is safe to copy to another device or commit with a project.

export type McpClientId = 'cursor' | 'claude-code';
export type McpSetupStep = { label: string; language: 'shell' | 'json'; text: string; note?: string };
export type McpClient = {
  id: McpClientId;
  name: string;
  /** The MCP transport both tools use with this server. */
  transport: 'Streamable HTTP';
  where: string;
  steps: (base: string) => McpSetupStep[];
  /** How to start the tool so it sees the variable. */
  start: string;
};

export const MCP_KEY_ENV = 'ANONYMO_API_KEY';
export const mcpEndpoint = (base: string) => `${base.replace(/\/+$/, '')}/mcp`;
const exportStep: McpSetupStep = {
  label: 'Put your key in your shell',
  language: 'shell',
  text: `export ${MCP_KEY_ENV}=${KEY_PLACEHOLDER}`,
  note: 'Replace the placeholder on your computer, or add the line to your shell profile. The key stays on that computer.',
};

export const MCP_CLIENTS: McpClient[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    transport: 'Streamable HTTP',
    where: '.cursor/mcp.json in your project',
    steps: (base) => [
      exportStep,
      {
        label: 'Add Anonymo to .cursor/mcp.json',
        language: 'json',
        // Cursor fills ${env:NAME} from its own environment when it loads the file.
        text: JSON.stringify({ mcpServers: { anonymo: { url: mcpEndpoint(base), headers: { Authorization: `Bearer \${env:${MCP_KEY_ENV}}` } } } }, null, 2),
        note: 'Cursor fills in ${env:ANONYMO_API_KEY} when it loads the file, so the file itself never holds the key.',
      },
    ],
    start: 'Start Cursor from that shell (cursor .) so it sees the variable, then turn on anonymo under Settings → MCP.',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    transport: 'Streamable HTTP',
    where: '.mcp.json in your project',
    steps: (base) => [
      exportStep,
      {
        label: 'Add Anonymo to Claude Code',
        language: 'shell',
        // Single quotes: the shell must not expand the variable here, or the key would be written into .mcp.json.
        text: `claude mcp add --transport http --scope project anonymo ${mcpEndpoint(base)} --header 'Authorization: Bearer \${${MCP_KEY_ENV}}'`,
        note: 'Keep the single quotes. Claude Code saves ${ANONYMO_API_KEY} as written and reads the key each time it starts.',
      },
    ],
    start: 'Start claude in that project from the same shell and approve the anonymo server when it asks.',
  },
];

/** The keyless setup a phone copies to finish on a computer: endpoint, every step, then how to start the tool. */
export function mcpSetupText(client: McpClient, base: string): string {
  const steps = client.steps(base).map((s, i) => `${i + 1}. ${s.label}\n${s.text}`);
  return [`Anonymo in ${client.name} (MCP, ${client.transport})`, `Server: ${mcpEndpoint(base)}`, '', ...steps.flatMap((s) => [s, '']), `${client.steps(base).length + 1}. ${client.start}`].join('\n');
}
