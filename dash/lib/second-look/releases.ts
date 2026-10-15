import { featureOn } from '../../components/dashboard/feature-switches.ts';

/** Preparation is not publication. Each tool needs its own explicit release approval. */
export const SECOND_LOOK_SWITCHES = {
  fomo: true,
  token: false,
  wallet: false,
  signature: false,
  follow: false,
  plan: false,
  movement: false,
  tax: false,
  inbox: false,
  steady: false,
  guarded: false,
  rooms: false,
  networks: false,
  telegram: false,
  mcp: false,
} satisfies Record<string, boolean>;
export type SecondLookTool = keyof typeof SECOND_LOOK_SWITCHES;
export function secondLookToolOn(tool: SecondLookTool) {
  return featureOn('secondLook') && SECOND_LOOK_SWITCHES[tool];
}
export function secondLookPathTool(path: string): SecondLookTool | null {
  const root = path.split('/')[1];
  if (path.split('/')[0] !== 'second-look') return null;
  if (root === 'fomo') return 'fomo';
  if (['resolve', 'tokens', 'reports'].includes(root)) return 'token';
  if (root === 'wallets') return 'wallet';
  if (root === 'signature') return 'signature';
  if (root === 'follow') return 'follow';
  if (root === 'planning' || root === 'cool-head') return 'plan';
  if (root === 'why-moved') return 'movement';
  if (root === 'tax') return 'tax';
  if (root === 'alerts' || root === 'push') return 'inbox';
  if (root === 'steady') return 'steady';
  if (root === 'guarded') return 'guarded';
  if (root === 'rooms') return 'rooms';
  if (root === 'networks') return 'networks';
  if (root === 'telegram') return 'telegram';
  if (root === 'mcp') return 'mcp';
  return null;
}
export function secondLookPathOn(path: string, method = 'GET') {
  if (!featureOn('secondLook')) return false;
  if (path === 'second-look/capabilities')
    return Object.values(SECOND_LOOK_SWITCHES).some(Boolean);
  // Existing entitlements are shared read-only account metadata; purchasing stays gated.
  if (path === 'second-look/steady' && method === 'GET')
    return ['token', 'follow', 'tax', 'steady'].some((tool) =>
      secondLookToolOn(tool as SecondLookTool),
    );
  const tool = secondLookPathTool(path);
  return tool !== null && secondLookToolOn(tool);
}
