// Browser-wallet payments over plain EIP-1193 (`window.ethereum`) with viem. No wallet SDK, no WalletConnect.
//
//   Stablecoins:  DepositRouter.depositWithPermit(token, amount, keyCommit, deadline, v, r, s) when the token supports
//                 EIP-2612 (USDG does), else ERC-20 approve(router, amount) then DepositRouter.deposit(token, amount,
//                 keyCommit). The router forwards the tokens to the treasury; the gateway credits the key once the
//                 Deposited log is deep enough, and the sending wallet becomes the refund address.
//   ANMO:         CoinPay.payWithPermit(amount, keyCommit, deadline, v, r, s), else approve then CoinPay.pay(amount,
//                 keyCommit). CoinPay BURNS the coins; the key gets usage-only credit at the USD value when credited.
//
// The key itself never touches the chain: only its one-way `key_commit` from GET /deposits does.

import {
  createPublicClient,
  createWalletClient,
  custom,
  domainSeparator,
  parseSignature,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type { EvmNetwork } from './chains.ts';
import { MUSD_PER_USD } from './money.ts';
import type { MicroUsd } from './types.ts';

// ---- ABI fragments ---------------------------------------------------------------------------------------------

/** IDepositRouter (gateway/contracts/src/anonymo/interfaces/IAnonymo.sol; full ABI: gateway/src/chain/abis.ts). */
export const DEPOSIT_ROUTER_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'keyCommit', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'depositWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'keyCommit', type: 'bytes32' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/** CoinPay: burns ANMO for usage-only credit. Written from the agreed interface, ahead of the contract. */
export const COIN_PAY_ABI = [
  {
    type: 'function',
    name: 'pay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'keyCommit', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'payWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'keyCommit', type: 'bytes32' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/** ERC-20 plus the EIP-2612 / EIP-5267 reads the permit path needs. */
export const ERC20_PERMIT_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function',
    name: 'eip712Domain',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'fields', type: 'bytes1' },
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'extensions', type: 'uint256[]' },
    ],
  },
] as const;

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

// ---- amounts (pure) ---------------------------------------------------------------------------------------------

const pow10 = (n: number) => 10n ** BigInt(n);

/** A stablecoin amount in token units for a USD amount (1:1). Exact for 6+ decimals; never more than asked below that. */
export function stableUnits(musd: MicroUsd, decimals: number): bigint {
  if (!Number.isSafeInteger(musd) || musd <= 0) throw new Error('Enter an amount above zero.');
  const scaled = BigInt(musd) * pow10(decimals);
  return scaled / BigInt(MUSD_PER_USD);
}

/** Parses a positive decimal string (a price) into an integer and its scale: "0.0125" → [125n, 4]. */
function decimal(value: string): [bigint, number] | null {
  const m = /^\s*(\d{1,30})(?:\.(\d{1,36}))?\s*$/.exec(value);
  if (!m) return null;
  const frac = m[2] ?? '';
  const n = BigInt(m[1] + frac);
  return n > 0n ? [n, frac.length] : null;
}

export type CoinQuote =
  | { ok: true; coins: bigint; usdMusd: MicroUsd; priceUsd: string; maxMusd: MicroUsd }
  | { ok: false; reason: 'unavailable' | 'invalid_amount' | 'over_max'; maxMusd: MicroUsd | null };

/**
 * How many coins pay for `musd`: usd / price_usd, rounded UP to the coin's smallest unit, so the estimate is never short.
 * Refuses amounts above `max_usd_per_payment`, and every amount while `price_usd` is null.
 */
export function quoteCoins(musd: MicroUsd, coin: { price_usd: string | null; max_usd_per_payment: string; token: { decimals: number } }): CoinQuote {
  const max = decimal(coin.max_usd_per_payment);
  const maxMusd = max ? Number((max[0] * BigInt(MUSD_PER_USD)) / pow10(max[1])) : null;
  if (coin.price_usd === null) return { ok: false, reason: 'unavailable', maxMusd };
  const price = decimal(coin.price_usd);
  if (!price) return { ok: false, reason: 'unavailable', maxMusd };
  if (!Number.isSafeInteger(musd) || musd <= 0) return { ok: false, reason: 'invalid_amount', maxMusd };
  if (maxMusd !== null && musd > maxMusd) return { ok: false, reason: 'over_max', maxMusd };
  // coins = (musd / 1e6) / (p / 10^s) * 10^d = musd * 10^s * 10^d / (1e6 * p), rounded up
  const num = BigInt(musd) * pow10(price[1]) * pow10(coin.token.decimals);
  const den = BigInt(MUSD_PER_USD) * price[0];
  const coins = (num + den - 1n) / den;
  return { ok: true, coins, usdMusd: musd, priceUsd: coin.price_usd, maxMusd: maxMusd ?? Number.POSITIVE_INFINITY };
}

/** Token units as a decimal string for display ("12.5", "0.000001"). */
export function formatUnits(units: bigint, decimals: number, maxFraction = 6): string {
  const whole = units / pow10(decimals);
  const frac = (units % pow10(decimals)).toString().padStart(decimals, '0');
  let shown = frac.slice(0, maxFraction).replace(/0+$/, '');
  // Rounded display must not hide a remainder: show more digits if the cut-off part is non-zero and nothing else is.
  if (!shown && /[1-9]/.test(frac)) shown = frac.replace(/0+$/, '');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return shown ? `${grouped}.${shown}` : grouped;
}

// ---- EIP-1193 -----------------------------------------------------------------------------------------------------

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

/** The injected wallet, if the browser has one. */
export function injectedProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  const browser = window as unknown as { ethereum?: Eip1193Provider; trustwallet?: { ethereum?: Eip1193Provider } };
  return [browser.ethereum, browser.trustwallet?.ethereum].find((provider) => typeof provider?.request === 'function') ?? null;
}

/** EIP-1193 error codes a person can act on. */
export function describeWalletError(error: unknown): string {
  const e = error as { code?: number; shortMessage?: string; message?: string; cause?: { code?: number } } | null;
  const code = e?.code ?? e?.cause?.code;
  if (code === 4001 || /user rejected|user denied/i.test(e?.message ?? '')) return 'You declined the request in your wallet. Nothing was sent.';
  if (code === -32002) return 'Your wallet already has a request waiting. Open it and finish or cancel that first.';
  if (code === 4100) return 'Your wallet did not allow this site. Connect it and try again.';
  if (code === 4902) return 'Your wallet does not know this chain and could not add it.';
  return e?.shortMessage ?? e?.message ?? 'The wallet request failed.';
}

export async function connectWallet(provider: Eip1193Provider): Promise<Address> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const first = accounts?.[0];
  if (!first || !/^0x[0-9a-fA-F]{40}$/.test(first)) throw new Error('Your wallet returned no account.');
  return first as Address;
}

export async function walletChainId(provider: Eip1193Provider): Promise<number> {
  return Number.parseInt((await provider.request({ method: 'eth_chainId' })) as string, 16);
}

/** Switch the wallet to `network`, adding the chain first if the wallet does not know it (EIP-3085 / EIP-3326). */
export async function ensureChain(provider: Eip1193Provider, network: EvmNetwork): Promise<void> {
  if ((await walletChainId(provider)) === network.chainId) return;
  const chainId = `0x${network.chainId.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    const code = (error as { code?: number; data?: { originalError?: { code?: number } } })?.code ?? (error as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code;
    if (code !== 4902) throw error;
    if (!network.rpcUrl) throw new Error(`Your wallet does not know ${network.name} and no RPC address is configured to add it.`);
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: network.name,
          rpcUrls: [network.rpcUrl],
          nativeCurrency: network.nativeCurrency,
          ...(network.explorer ? { blockExplorerUrls: [network.explorer] } : {}),
        },
      ],
    });
  }
  if ((await walletChainId(provider)) !== network.chainId) throw new Error(`Switch your wallet to ${network.name} and try again.`);
}

function clients(provider: Eip1193Provider, network: EvmNetwork, account: Address) {
  const chain = {
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: network.rpcUrl ? [network.rpcUrl] : [] } },
  } as const;
  const transport = custom(provider as Parameters<typeof custom>[0]);
  return {
    pub: createPublicClient({ chain, transport }) as PublicClient,
    wallet: createWalletClient({ chain, transport, account }) as WalletClient,
  };
}

// ---- permit or approve --------------------------------------------------------------------------------------------

/** The token's EIP-712 domain, checked against its on-chain DOMAIN_SEPARATOR; null when it does not support EIP-2612. */
export type PermitDomain = { name: string; version: string; chainId: number; verifyingContract: Address };

export async function permitDomain(pub: PublicClient, token: Address, chainId: number): Promise<PermitDomain | null> {
  const read = <T>(functionName: 'name' | 'version' | 'DOMAIN_SEPARATOR' | 'eip712Domain') =>
    pub.readContract({ address: token, abi: ERC20_PERMIT_ABI, functionName }).then(
      (v) => v as T,
      () => null,
    );
  const separator = await read<Hex>('DOMAIN_SEPARATOR');
  if (!separator) return null;
  const candidates: PermitDomain[] = [];
  const eip5267 = await read<readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]]>('eip712Domain');
  if (eip5267) candidates.push({ name: eip5267[1], version: eip5267[2], chainId, verifyingContract: token });
  const name = eip5267?.[1] ?? (await read<string>('name'));
  if (name !== null) {
    const version = await read<string>('version');
    for (const v of [version, '1', '2']) if (v !== null) candidates.push({ name, version: v, chainId, verifyingContract: token });
  }
  // Only sign a permit whose domain provably matches the token's: a wrong guess would just revert, costing gas.
  return candidates.find((d) => domainSeparator({ domain: d }).toLowerCase() === separator.toLowerCase()) ?? null;
}

export type PayStep = 'connecting' | 'switching' | 'checking' | 'signing' | 'approving' | 'sending' | 'confirming' | 'submitted';
export type PayResult = { hash: Hex; method: 'permit' | 'approve' | 'allowance'; from: Address };

type PayPlan = {
  provider: Eip1193Provider;
  network: EvmNetwork;
  token: { address: Address; symbol: string; decimals: number };
  spender: Address;
  amount: bigint;
  /** The call that moves the tokens once the spender may take them. */
  plain: (pub: PublicClient, wallet: WalletClient, account: Address) => Promise<Hex>;
  /** The same call with a signed permit attached. */
  withPermit: (wallet: WalletClient, account: Address, deadline: bigint, sig: { v: number; r: Hex; s: Hex }) => Promise<Hex>;
  onStep?: (step: PayStep) => void;
  onBroadcast?: (hash: Hex) => void;
  /** Seconds the permit stays valid. */
  permitTtl?: number;
};

async function pay(plan: PayPlan): Promise<PayResult> {
  const step = plan.onStep ?? (() => undefined);
  step('connecting');
  const account = await connectWallet(plan.provider);
  step('switching');
  await ensureChain(plan.provider, plan.network);
  const { pub, wallet } = clients(plan.provider, plan.network, account);

  step('checking');
  // A call to an address with no code "succeeds" and moves nothing, so a wrong address in the instructions or a wallet
  // on the wrong network must stop here, before anything is signed.
  for (const [what, address] of [
    ['payment contract', plan.spender],
    [`${plan.token.symbol} token`, plan.token.address],
  ] as const) {
    const code = await pub.getCode({ address });
    if (!code || code === '0x') throw new Error(`There is no ${what} at ${address} on ${plan.network.name}. Nothing was sent.`);
  }
  const balance =(await pub.readContract({ address: plan.token.address, abi: ERC20_PERMIT_ABI, functionName: 'balanceOf', args: [account] })) as bigint;
  if (balance < plan.amount)
    throw new Error(`This wallet holds ${formatUnits(balance, plan.token.decimals)} ${plan.token.symbol}; ${formatUnits(plan.amount, plan.token.decimals)} is needed.`);
  const allowance = (await pub.readContract({ address: plan.token.address, abi: ERC20_PERMIT_ABI, functionName: 'allowance', args: [account, plan.spender] })) as bigint;

  let method: PayResult['method'] = 'allowance';
  let hash: Hex;
  if (allowance >= plan.amount) {
    step('sending');
    hash = await plan.plain(pub, wallet, account);
  } else {
    const domain = await permitDomain(pub, plan.token.address, plan.network.chainId);
    if (domain) {
      method = 'permit';
      const nonce = (await pub.readContract({ address: plan.token.address, abi: ERC20_PERMIT_ABI, functionName: 'nonces', args: [account] })) as bigint;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + (plan.permitTtl ?? 30 * 60));
      step('signing');
      const signature = await wallet.signTypedData({
        account,
        domain,
        types: PERMIT_TYPES,
        primaryType: 'Permit',
        message: { owner: account, spender: plan.spender, value: plan.amount, nonce, deadline },
      });
      const sig = parseSignature(signature);
      const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
      step('sending');
      hash = await plan.withPermit(wallet, account, deadline, { v, r: sig.r, s: sig.s });
    } else {
      method = 'approve';
      step('approving');
      const approval = await wallet.writeContract({
        account,
        chain: wallet.chain,
        address: plan.token.address,
        abi: ERC20_PERMIT_ABI,
        functionName: 'approve',
        args: [plan.spender, plan.amount],
      });
      const approved = await pub.waitForTransactionReceipt({ hash: approval });
      if (approved.status !== 'success') throw new Error('The approval transaction failed. Nothing was paid.');
      step('sending');
      hash = await plan.plain(pub, wallet, account);
    }
  }
  plan.onBroadcast?.(hash);
  step('confirming');
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The payment transaction reverted. Nothing was paid.');
  step('submitted');
  return { hash, method, from: account };
}

/** Deposit a stablecoin to the key's commitment through the DepositRouter (permit when possible, else approve). */
export function depositStablecoin(o: {
  provider: Eip1193Provider;
  network: EvmNetwork;
  router: Address;
  token: { address: Address; symbol: string; decimals: number };
  keyCommit: Hex;
  amount: bigint;
  onStep?: (step: PayStep) => void;
  onBroadcast?: (hash: Hex) => void;
}): Promise<PayResult> {
  return pay({
    ...o,
    spender: o.router,
    plain: (_pub, wallet, account) =>
      wallet.writeContract({ account, chain: wallet.chain, address: o.router, abi: DEPOSIT_ROUTER_ABI, functionName: 'deposit', args: [o.token.address, o.amount, o.keyCommit] }),
    withPermit: (wallet, account, deadline, s) =>
      wallet.writeContract({
        account,
        chain: wallet.chain,
        address: o.router,
        abi: DEPOSIT_ROUTER_ABI,
        functionName: 'depositWithPermit',
        args: [o.token.address, o.amount, o.keyCommit, deadline, s.v, s.r, s.s],
      }),
  });
}

/** Pay with ANMO through CoinPay (permit when possible, else approve). The coins are burned. */
export function payWithCoin(o: {
  provider: Eip1193Provider;
  network: EvmNetwork;
  coinPay: Address;
  token: { address: Address; symbol: string; decimals: number };
  keyCommit: Hex;
  amount: bigint;
  onStep?: (step: PayStep) => void;
  onBroadcast?: (hash: Hex) => void;
}): Promise<PayResult> {
  return pay({
    ...o,
    spender: o.coinPay,
    plain: (_pub, wallet, account) =>
      wallet.writeContract({ account, chain: wallet.chain, address: o.coinPay, abi: COIN_PAY_ABI, functionName: 'pay', args: [o.amount, o.keyCommit] }),
    withPermit: (wallet, account, deadline, s) =>
      wallet.writeContract({ account, chain: wallet.chain, address: o.coinPay, abi: COIN_PAY_ABI, functionName: 'payWithPermit', args: [o.amount, o.keyCommit, deadline, s.v, s.r, s.s] }),
  });
}

/** The deposit row the gateway records for a transaction (`ref` is `<chain>:<txhash>:<logIndex>` on EVM). */
export const rowForTx = <R extends { ref: string }>(rows: R[], hash: string) => rows.find((r) => r.ref.toLowerCase().includes(hash.toLowerCase()));
