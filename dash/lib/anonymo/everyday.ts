import {
  parseAbi, parseSignature, stringToHex, type Address, type Hex,
} from 'viem';
import { evmNetwork } from './chains.ts';
import {
  connectWallet, ensureChain, ERC20_PERMIT_ABI, permitDomain, walletClients, type Eip1193Provider,
} from './wallet.ts';

export const PASS_SKUS = ['PASS30', 'PASS30_PLUS'] as const;
export type PassSku = typeof PASS_SKUS[number];
export type PassRail = 'USDG' | 'NYMO';
export type PassRecord = { orderId: Hex; sku: PassSku; starts: string; ends: string };
type Product = { usd: number; voiceSeconds: number; images: number; council: boolean; party: number };
export type PassOffer = {
  chainId: number;
  checkout: { address: Address; usdg: Address; nymo: Address | null; paused: boolean } | null;
  passes: PassRecord[];
  fairUse: number;
  confirmations: number;
  products: Record<PassSku, Product>;
};
export type PassOrder = { ref: Hex; orderId: Hex; checkout: Address; sku: PassSku };
export type Tier = 'Free' | 'Plus' | 'Pro' | 'Black';
export type EverydayLimits = { memoryItems: number | null; dailyVoiceSeconds: number; partyPlayers: number; council: boolean; priority: boolean };
export type EverydayAccess = EverydayLimits & { hasPass: boolean; availableCreditsUsd: number };
export type StakeSummary = {
  wallet: Address | null;
  tier: Tier;
  twab: string;
  day: string;
  dailyCreditsUsd: number;
  availableCreditsUsd: number;
  tierTable: { minTwab: string; dailyMicroUsd: string }[] | null;
  limits: EverydayLimits;
};
export type StakeContract = { chainId: number; address: Address | null };

const checkoutAbi = parseAbi([
  'function usdg() view returns (address)',
  'function nymo() view returns (address)',
  'function paused() view returns (bool)',
  'function priceOf(bytes32 sku, uint256 qty) pure returns (uint256)',
  'function quoteNYMO(bytes32 sku, uint256 qty) view returns (uint256)',
  'function orderNonce(bytes32 sku, uint256 qty, bytes32 orderRef) pure returns (bytes32)',
  'function payUSDG(bytes32 sku, uint256 qty, (address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 orderRef, uint8 v, bytes32 r, bytes32 s) auth) returns (bytes32)',
  'function payNYMO(bytes32 sku, uint256 qty, (bytes32 orderRef, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permit) returns (bytes32)',
]);
const stakeAbi = parseAbi([
  'function nymo() view returns (address)',
  'function paused() view returns (bool)',
  'function stakedOf(address account) view returns (uint256)',
  'function stake(uint256 amount)',
  'function unstake(uint256 amount)',
]);
const RECEIVE_AUTH = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export async function everydayWallet(provider: Eip1193Provider, chainId: number) {
  const network = evmNetwork('rhc', { chain_id: chainId });
  const account = await connectWallet(provider);
  await ensureChain(provider, network);
  return { account, ...walletClients(provider, network, account) };
}
type Connection = Awaited<ReturnType<typeof everydayWallet>>;
type Checkout = NonNullable<PassOffer['checkout']>;
const signatureParts = (signature: Hex) => {
  const { r, s, v, yParity } = parseSignature(signature);
  return { r, s, v: v == null ? 27 + (yParity ?? 0) : Number(v) };
};

export class WalletTransactionReverted extends Error {}

async function confirmTx({ pub }: Connection, hash: Hex) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new WalletTransactionReverted('The wallet transaction reverted.');
}

async function approve(connection: Connection, token: Address, spender: Address, amount: bigint) {
  const { pub, wallet, account } = connection;
  const allowance = await pub.readContract({ address: token, abi: ERC20_PERMIT_ABI, functionName: 'allowance', args: [account, spender] });
  if (allowance >= amount) return;
  const hash = await wallet.writeContract({
    account, chain: wallet.chain, address: token, abi: ERC20_PERMIT_ABI, functionName: 'approve', args: [spender, amount],
  });
  await confirmTx(connection, hash);
}

export async function passPrice({ pub }: Connection, checkout: Checkout, product: PassSku, rail: PassRail) {
  const opts = { address: checkout.address, abi: checkoutAbi } as const;
  const sku = stringToHex(product, { size: 32 });
  const [token, amount] = await Promise.all([
    pub.readContract({ ...opts, functionName: rail === 'NYMO' ? 'nymo' : 'usdg' }),
    pub.readContract({ ...opts, functionName: rail === 'NYMO' ? 'quoteNYMO' : 'priceOf', args: [sku, 1n] }),
  ]);
  const expected = rail === 'NYMO' ? checkout.nymo : checkout.usdg;
  if (token.toLowerCase() !== expected?.toLowerCase() || amount <= 0n) throw new Error('The checkout details changed. Review a fresh quote.');
  return { token, amount };
}

export async function buyPass(connection: Connection, checkout: Checkout, order: PassOrder, rail: PassRail, maxAmount: bigint, onBroadcast: (hash: Hex) => void) {
  const { pub, wallet, account } = connection;
  if (order.checkout.toLowerCase() !== checkout.address.toLowerCase()) throw new Error('The checkout changed. Review a fresh quote.');
  const { token, amount } = await passPrice(connection, checkout, order.sku, rail);
  if (amount > maxAmount || (rail === 'USDG' && amount !== maxAmount)) throw new Error('The price changed. Review a fresh quote.');
  const sku = stringToHex(order.sku, { size: 32 });
  const opts = { address: checkout.address, abi: checkoutAbi } as const;
  if (await pub.readContract({ ...opts, functionName: 'paused' })) throw new Error('New pass purchases are paused.');
  let hash: Hex;
  if (rail === 'USDG') {
    const domain = await permitDomain(pub, token, wallet.chain!.id);
    if (!domain) throw new Error('The checkout could not verify the USDG signing domain.');
    const [nonce, block] = await Promise.all([
      pub.readContract({ ...opts, functionName: 'orderNonce', args: [sku, 1n, order.ref] }),
      pub.getBlock(),
    ]);
    const message = { from: account, to: checkout.address, value: amount, validAfter: 0n, validBefore: block.timestamp + 600n, nonce };
    const signature = await wallet.signTypedData({ account, domain, types: RECEIVE_AUTH, primaryType: 'ReceiveWithAuthorization', message });
    const { request } = await pub.simulateContract({
      ...opts, functionName: 'payUSDG', account,
      args: [sku, 1n, { ...message, ...signatureParts(signature), orderRef: order.ref }],
    });
    hash = await wallet.writeContract({ ...request, chain: wallet.chain });
  } else {
    await approve(connection, token, checkout.address, maxAmount);
    const zero = stringToHex('', { size: 32 });
    const { request } = await pub.simulateContract({
      ...opts, functionName: 'payNYMO', account,
      args: [sku, 1n, { orderRef: order.ref, value: maxAmount, deadline: 0n, v: 0, r: zero, s: zero }],
    });
    hash = await wallet.writeContract({ ...request, chain: wallet.chain });
  }
  onBroadcast(hash);
  await confirmTx(connection, hash);
}

export async function stakePosition({ pub, account }: Connection, address: Address) {
  const opts = { address, abi: stakeAbi } as const;
  const [staked, paused] = await Promise.all([
    pub.readContract({ ...opts, functionName: 'stakedOf', args: [account] }),
    pub.readContract({ ...opts, functionName: 'paused' }).catch(() => null),
  ]);
  return { staked, paused };
}

export function stakeControls(amount: bigint, position: { staked: bigint; paused: boolean | null } | null, busy: boolean) {
  return {
    stake: !busy && amount > 0n && position?.paused === false,
    unstake: !busy && amount > 0n && !!position && amount <= position.staked,
  };
}

export async function moveStake(connection: Connection, address: Address, action: 'stake' | 'unstake', amount: bigint, onBroadcast: (hash: Hex) => void) {
  const { pub, wallet, account } = connection;
  const opts = { address, abi: stakeAbi } as const;
  if (action === 'stake') {
    if (await pub.readContract({ ...opts, functionName: 'paused' })) throw new Error('New stakes are paused.');
    const token = await pub.readContract({ ...opts, functionName: 'nymo' });
    await approve(connection, token, address, amount);
  }
  const { request } = await pub.simulateContract({ ...opts, functionName: action, account, args: [amount] });
  const hash = await wallet.writeContract({ ...request, chain: wallet.chain });
  onBroadcast(hash);
  await confirmTx(connection, hash);
}
