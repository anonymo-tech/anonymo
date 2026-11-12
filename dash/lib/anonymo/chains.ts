import type { DepositChain, DepositToken } from './types.ts';

/** Deposit rails from Overview §5 and Backend §2/§7: stablecoins credited 1:1, BTC and Lightning at the BTCPay quote. */
export const CHAINS: Record<DepositChain, { name: string; tokens: DepositToken[]; note: string }> = {
  base: { name: 'Base', tokens: ['USDC', 'USDT', 'USDG'], note: 'Credited 1:1.' },
  arbitrum: { name: 'Arbitrum', tokens: ['USDC', 'USDT', 'USDG'], note: 'Credited 1:1.' },
  rhc: { name: 'Robinhood Chain', tokens: ['USDC', 'USDT', 'USDG'], note: 'Credited 1:1.' },
  solana: { name: 'Solana', tokens: ['USDC', 'USDT'], note: 'Credited 1:1.' },
  tron: { name: 'Tron', tokens: ['USDT'], note: 'Credited 1:1.' },
  btc: { name: 'Bitcoin', tokens: ['BTC'], note: 'Credited at the BTCPay quote when it confirms.' },
  ln: { name: 'Lightning', tokens: ['BTC'], note: 'Pay a one-time invoice. Credited at the BTCPay quote.' },
};

export const CHAIN_ORDER: DepositChain[] = ['base', 'arbitrum', 'rhc', 'solana', 'tron', 'btc', 'ln'];

export const shortAddress = (address: string, keep = 6) =>
  address.length <= keep * 2 + 1 ? address : `${address.slice(0, keep)}…${address.slice(-keep)}`;
