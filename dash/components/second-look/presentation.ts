import {
  TOKEN_CHECK_LABELS,
  type TokenReport,
  type TokenCheckId,
} from '../../lib/second-look/token.ts';
import type { WalletPnl } from '../../lib/second-look/wallet.ts';

export function walletFeeRows(
  fees: WalletPnl['fees'],
): [string, string | null][] {
  const combined =
    fees.networkAndPriorityUsd6 !== null &&
    (fees.networkUsd6 === null || fees.priorityUsd6 === null);
  return [
    ...(combined
      ? [
          [
            'Network & priority fees · combined',
            fees.networkAndPriorityUsd6,
          ] as [string, string | null],
        ]
      : [
          ['Network fees', fees.networkUsd6] as [string, string | null],
          ['Priority fees', fees.priorityUsd6] as [string, string | null],
        ]),
    ['Jito tips', fees.jitoTipUsd6],
    ['Platform fees', fees.platformUsd6],
  ];
}

export const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export function tokenIdentity(mint: string) {
  if (mint === JUP_MINT)
    return { name: 'Jupiter', symbol: 'JUP', image: '/brand/tokens/jup.png' };
  if (mint === SOL_MINT)
    return { name: 'Solana', symbol: 'SOL', image: '/brand/tokens/sol.png' };
  if (mint === USDC_MINT)
    return {
      name: 'USD Coin',
      symbol: 'USDC',
      image: '/brand/tokens/usdc.png',
    };
  return { name: 'Solana token', symbol: mint.slice(0, 5), image: null };
}
export const verdictLabel = {
  checking: 'Checking',
  withheld: 'Facts only',
  red_flags: 'Red flags found',
  caution: 'Caution',
  no_red_flags: 'No red flags found',
};
export const checkGroups = [
  { id: 'overview', label: 'Overview', checks: [1, 2, 4, 5, 7, 9] },
  { id: 'controls', label: 'Controls', checks: [1, 2, 3, 10, 13] },
  { id: 'holders', label: 'Holders', checks: [5, 6, 7] },
  { id: 'liquidity', label: 'Liquidity', checks: [4, 9, 12] },
  { id: 'launch', label: 'Launch', checks: [7, 8, 11, 12] },
  { id: 'claims', label: 'Claims', checks: [] },
] as const;
export const factText = (value: string | number | boolean | null) =>
  value === null
    ? 'Not available'
    : typeof value === 'boolean'
      ? value
        ? 'Yes'
        : 'No'
      : String(value);
export function readableCode(value: string) {
  if (value === 'MARKET_EVIDENCE_UNAVAILABLE')
    return 'Market activity and liquidity could not be verified.';
  return value.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
export function utcTime(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value));
}

/** User-invoked interface example. Never submitted, saved, charged or merged into live results. */
export function exampleTokenReport(): TokenReport {
  const now = new Date().toISOString();
  const facts: [string, string | number | boolean][][] = [
    [
      ['Mint authority', false],
      ['Freeze authority', false],
      ['Program', 'SPL Token'],
    ],
    [['Token-2022 extensions', 'Not applicable']],
    [['Metadata mutable', true]],
    [
      ['Buy → sell', 'Succeeded'],
      ['Round-trip cost', '2.1%'],
      ['Simulation size', '$20'],
    ],
    [
      ['Top 10 share', '36%'],
      ['Excluded', 'Pools, curves and burn addresses'],
    ],
    [
      ['Possibly linked clusters', 3],
      ['Combined supply', '12%'],
    ],
    [
      ['Initially bought', '42%'],
      ['Still held', '18%'],
      ['Window', 'Create slot + 0–4'],
    ],
    [
      ['Prior tokens', 8],
      ['Fell ≥90% within 24h', 0],
    ],
    [
      ['Liquidity', '$84,000'],
      ['Impact · $100', '0.2%'],
      ['Impact · $1,000', '2.8%'],
      ['Impact · $10,000', '19.0%'],
    ],
    [['Matching mint', 'Selected explicitly']],
    [['Active paid boosts', 0]],
    [
      ['Unique buyers · 24h', 652],
      ['Buys · 24h', 1219],
      ['Sells · 24h', 908],
    ],
    [['External findings', 'No additional example findings']],
  ];
  return {
    id: '00000000-0000-4000-8000-000000000001',
    mint: JUP_MINT,
    cluster: 'mainnet-beta',
    ruleset: 'bfb-1',
    mode: 'standard',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    state: 'complete',
    checks: TOKEN_CHECK_LABELS.map((label, i) => ({
      id: (i + 1) as TokenCheckId,
      label,
      status: 'complete',
      risk: [2, 4, 6].includes(i) ? 'caution' : 'none',
      facts: facts[i].map(([label, value], n) => ({
        key: `example_${n}`,
        label,
        value,
      })),
      sources: [],
      limitations:
        i === 5
          ? [
              'A link is evidence of shared activity, not proof of the same owner.',
            ]
          : [],
    })),
    verdict: 'caution',
    reasons: [
      'Top 10 wallets hold 36% of supply.',
      'Early buyers still hold 18%.',
      'Metadata can change.',
    ],
    limitations: ['Illustrative report. These are not findings about Jupiter.'],
    calibration: {
      status: 'missing',
      version: null,
      evidenceUrl: null,
      ageBand: 'unknown',
      baseRate: null,
    },
    deep: null,
    cached: false,
    billing: { maximumUsd6: '0', actualUsd6: '0', state: 'free' },
  };
}
