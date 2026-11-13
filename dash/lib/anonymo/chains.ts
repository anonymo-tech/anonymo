import type { DepositChain, EvmChain } from './types.ts';

/** Display names and the credit rule for every chain a deposit row, a source or a withdrawal can name. */
export const CHAINS: Record<DepositChain, { name: string; note: string }> = {
  base: { name: 'Base', note: 'Stablecoins credit 1:1.' },
  arbitrum: { name: 'Arbitrum', note: 'Stablecoins credit 1:1.' },
  rhc: { name: 'Robinhood Chain', note: 'Stablecoins credit 1:1.' },
  solana: { name: 'Solana', note: 'Stablecoins credit 1:1.' },
  tron: { name: 'Tron', note: 'USDT credits 1:1.' },
  btc: { name: 'Bitcoin', note: 'Credited at the BTCPay quote when it confirms.' },
  ln: { name: 'Lightning', note: 'Credited at the BTCPay quote.' },
  coin: { name: 'ANMO', note: 'Usage-only credit at the USD value when credited. Never withdrawable.' },
};

export const chainName = (chain: string) => CHAINS[chain as DepositChain]?.name ?? chain;

/** What a browser wallet needs to switch to (or add) an EVM chain. */
export type EvmNetwork = {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string | null;
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

const ETH = { name: 'Ether', symbol: 'ETH', decimals: 18 };

// Robinhood Chain mainnet is 4663 (gateway/config/rhc-mainnet.json). Testnet is 46630; its public RPC is not recorded in
// this repository, so set NEXT_PUBLIC_ANONYMO_RHC_RPC with NEXT_PUBLIC_ANONYMO_RHC_CHAIN_ID=46630.
const RHC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ANONYMO_RHC_CHAIN_ID ?? '') || 4663;
const RHC_RPC = process.env.NEXT_PUBLIC_ANONYMO_RHC_RPC || (RHC_CHAIN_ID === 4663 ? 'https://rpc.mainnet.chain.robinhood.com' : '');

const DEFAULT_NETWORKS: Record<EvmChain, EvmNetwork> = {
  base: { chainId: 8453, name: 'Base', rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org', nativeCurrency: ETH },
  arbitrum: { chainId: 42161, name: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io', nativeCurrency: ETH },
  rhc: {
    chainId: RHC_CHAIN_ID,
    name: RHC_CHAIN_ID === 4663 ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
    rpcUrl: RHC_RPC,
    explorer: null,
    nativeCurrency: ETH,
  },
};

/**
 * Optional override for every EVM chain, as JSON: NEXT_PUBLIC_ANONYMO_EVM_NETWORKS='{"rhc":{"chainId":31337,
 * "rpcUrl":"http://127.0.0.1:8545"}}'. Used for testnets and local test chains.
 */
function overrides(): Partial<Record<EvmChain, Partial<EvmNetwork>>> {
  const raw = process.env.NEXT_PUBLIC_ANONYMO_EVM_NETWORKS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Record<EvmChain, Partial<EvmNetwork>>>) : {};
  } catch {
    return {};
  }
}

/** The network for an EVM chain: the gateway's own values when it sends them, then the override, then the defaults. */
export function evmNetwork(chain: EvmChain, fromGateway: { chain_id?: number; rpc_url?: string } = {}): EvmNetwork {
  const base = { ...DEFAULT_NETWORKS[chain], ...overrides()[chain] };
  return {
    ...base,
    chainId: fromGateway.chain_id ?? base.chainId,
    rpcUrl: fromGateway.rpc_url ?? base.rpcUrl,
  };
}

export const shortAddress = (address: string, keep = 6) =>
  address.length <= keep * 2 + 1 ? address : `${address.slice(0, keep)}…${address.slice(-keep)}`;
