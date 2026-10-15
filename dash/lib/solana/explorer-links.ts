export type ExplorerTransaction = {
  signature: string;
  cluster: string;
  source: 'signature' | 'link';
};

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const explorerHosts = new Set(['solscan.io', 'explorer.solana.com', 'solana.fm']);

// Count decoded bytes without accepting 32-byte public keys or overlong encodings.
function isSignature(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) return false;
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(alphabet.indexOf(character));
  let bytes = 0;
  while (number > 0n) {
    bytes++;
    number >>= 8n;
  }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 64;
}

/** Find occurrences, preserving link networks. Bare signatures have no network evidence. */
export function parseExplorerLinks(text: string): ExplorerTransaction[] {
  const found: { index: number; transaction: ExplorerTransaction }[] = [];
  // Mask all URLs before scanning bare signatures, including unsupported hosts/paths.
  const remaining = text.replace(
    /[a-z][a-z0-9+.-]*:\/\/[^\s<>"`]+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"`]+/gi,
    (raw, index: number) => {
      try {
        const link = raw.replace(/[.,;:!?)\]}]+$/, '');
        const url = new URL(link.includes('://') ? link : `https://${link}`);
        const host = url.hostname.replace(/^www\./, '');
        const signature = url.pathname.match(/^\/tx\/([^/]+)\/?$/)?.[1];
        if (
          (url.protocol === 'https:' || url.protocol === 'http:') &&
          !url.username && !url.password && !url.port &&
          explorerHosts.has(host) && signature && isSignature(signature)
        ) {
          const cluster = url.searchParams.get('cluster') || 'mainnet-beta';
          found.push({ index, transaction: {
            signature,
            cluster: cluster === 'mainnet' ? 'mainnet-beta' : cluster,
            source: 'link',
          } });
        }
      } catch {
        // Malformed links are not transaction references.
      }
      return ' '.repeat(raw.length);
    },
  );
  for (const match of remaining.matchAll(/(?<![a-z0-9_])[1-9A-HJ-NP-Za-km-z]{64,88}(?![a-z0-9_])/gi)) {
    if (isSignature(match[0])) found.push({ index: match.index, transaction: {
      signature: match[0], cluster: 'mainnet-beta', source: 'signature',
    } });
  }
  return found.sort((a, b) => a.index - b.index).map(({ transaction }) => transaction);
}

export function explorerNetworkStatus(
  transaction: ExplorerTransaction,
  configuredCluster: 'devnet' | 'mainnet-beta' | null,
): 'ready' | 'different-cluster' | 'unconfigured' {
  if (transaction.source === 'signature') return 'ready';
  if (!configuredCluster) return 'unconfigured';
  return transaction.cluster === configuredCluster ? 'ready' : 'different-cluster';
}

/** GET share targets supply plain text; preserve it without sending a message. */
export function sharedComposerText(params: URLSearchParams): string {
  return ['title', 'text', 'url'].map((name) => params.get(name) ?? '').filter(Boolean).join('\n\n');
}

export function dashboardLinkInput(
  params: URLSearchParams,
  features: { explorerLinks: boolean; explainer: boolean; shareTarget: boolean },
): { transaction: ExplorerTransaction | null; sharedText: string; removeParams: string[] } {
  const explorerEnabled = features.explorerLinks && features.explainer;
  const sharedText = features.shareTarget ? sharedComposerText(params) : '';
  const explainMatches = explorerEnabled ? parseExplorerLinks(params.get('explain') ?? '') : [];
  // Android can repeat the same link in both text and url.
  const sharedMatches = [...new Map(
    (explorerEnabled && sharedText ? parseExplorerLinks(sharedText) : [])
      .map((transaction) => [`${transaction.signature}:${transaction.cluster}`, transaction]),
  ).values()];
  return {
    transaction: explainMatches.length === 1 ? explainMatches[0]
      : sharedMatches.length === 1 ? sharedMatches[0] : null,
    sharedText,
    removeParams: [
      ...(explorerEnabled ? ['explain'] : []),
      ...(features.shareTarget ? ['title', 'text', 'url'] : []),
    ].filter((name) => params.has(name)),
  };
}
