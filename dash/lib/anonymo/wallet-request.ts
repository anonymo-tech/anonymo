// 08 What am I signing? A read-only review of one wallet request the person pastes in. It starts with the most common
// way an app gets lasting access to someone's tokens: an ERC-20 approve(spender, amount) on an EVM chain.
//
// Accepted input (anything else is refused with a reason):
//   1. eth_sendTransaction parameters as JSON: {"from","to","data","chainId","value"?}, or the whole JSON-RPC call
//      {"method":"eth_sendTransaction","params":[{...}]}. chainId may be a number or hex.
//   2. An EIP-681 link: ethereum:<token>@<chainId>/approve?address=<spender>&uint256=<amount>
//
// Facts come from deterministic decoding (viem) and integer arithmetic only. Token names and decimals are used only
// when the gateway's verified deposit contracts list that exact token on that chain; anything else stays an address
// and a raw integer. Nothing here can sign, send or approve: there is no wallet provider in this module at all. The
// optional simulation is a plain JSON-RPC read (eth_call / eth_simulateV1) to a public RPC the person chose to ask.

import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, maxUint256, toEventSelector, toFunctionSelector, type Address, type Hex } from 'viem';
import { ERC20_PERMIT_ABI, formatUnits } from './wallet.ts';
import type { DepositContracts, EvmChain } from './types.ts';

/** Chat hands a pasted request to /dashboard/wallet-review in this tab's sessionStorage, never in the URL. */
export const WALLET_REVIEW_DRAFT = 'anonymo.wallet-review.draft';

/** Cheap first check before parsing a chat draft: only JSON or an ethereum: link can be a wallet request. */
export const mightBeWalletRequest = (text: string) => /^\s*(\{|ethereum:)/i.test(text) && text.length <= 20_000;

export type WalletRequest = {
  source: 'json' | 'eip681';
  chainId: number;
  from: Address | null;
  to: Address;
  data: Hex;
  value: bigint;
};

export type RequestRefusal = {
  ok: false;
  code: 'empty' | 'format' | 'signature' | 'method' | 'chain' | 'address' | 'data' | 'call' | 'amount';
  message: string;
};

const SIGNING_METHODS = /^(eth_sign|personal_sign|eth_signTypedData(_v[1-4])?|eth_signTransaction|wallet_sendCalls)$/;
const APPROVE = toFunctionSelector('approve(address,uint256)');

const refuse = (code: RequestRefusal['code'], message: string): RequestRefusal => ({ ok: false, code, message });

function parseQuantity(value: unknown): bigint | null {
  if (value === undefined || value === null || value === '') return 0n;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^0x[0-9a-fA-F]+$/.test(v) || /^\d+$/.test(v)) return BigInt(v);
  return null;
}

function parseChainId(value: unknown): number | null {
  const q = parseQuantity(value);
  if (q === null || q === 0n || q > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(q);
}

/** EIP-681 numbers may use an exponent ("2.5e6"). Only exact non-negative integers are accepted. */
export function parseEip681Number(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE](\d+))?$/.exec(text.trim());
  if (!m) return null;
  const [, whole, frac = '', exp = '0'] = m;
  const e = Number(exp);
  if (!Number.isSafeInteger(e) || e > 200) return null;
  if (frac.replace(/0+$/, '').length > e) return null;
  const digits = (whole + frac.padEnd(e, '0')).replace(/^0+(?=\d)/, '');
  return BigInt(digits);
}

/** Read what was pasted. It never guesses: a missing chain, a signature request or an unknown shape is refused. */
export function parseWalletRequest(input: string): { ok: true; request: WalletRequest } | RequestRefusal {
  const text = input.trim();
  if (!text) return refuse('empty', 'Paste a wallet request to review it.');

  if (/^ethereum:/i.test(text)) {
    const m = /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?\/(\w+)(?:\?(.*))?$/i.exec(text);
    if (!m) return refuse('format', 'This ethereum: link is not in a form that can be checked.');
    const [, target, chain, fn, query = ''] = m;
    if (!chain) return refuse('chain', 'The link does not say which chain it is for, so it cannot be checked.');
    if (fn !== 'approve') return refuse('call', `This link calls ${fn}. Only token approvals can be reviewed so far.`);
    const q = new URLSearchParams(query);
    const spender = q.get('address') ?? '';
    const amount = parseEip681Number(q.get('uint256') ?? '');
    if (!isAddress(spender, { strict: false })) return refuse('address', 'The spender address in the link is not a valid address.');
    if (amount === null || amount > maxUint256) return refuse('amount', 'The amount in the link is not a whole number of token units.');
    return {
      ok: true,
      request: {
        source: 'eip681',
        chainId: Number(chain),
        from: null,
        to: getAddress(target),
        data: encodeFunctionData({ abi: ERC20_PERMIT_ABI, functionName: 'approve', args: [getAddress(spender), amount] }),
        value: 0n,
      },
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse('format', 'This is neither a transaction in JSON nor an ethereum: link.');
  }
  let tx = json as Record<string, unknown> | null;
  if (tx && typeof tx === 'object' && 'method' in tx) {
    const method = String(tx.method);
    if (SIGNING_METHODS.test(method))
      return refuse('signature', `This is a ${method} signature request. Signatures are not supported here yet. A signed permit can grant spending rights without a transaction, so check it carefully in your wallet.`);
    if (method !== 'eth_sendTransaction') return refuse('method', `${method} is not a transaction this page can review.`);
    tx = Array.isArray(tx.params) ? (tx.params[0] as Record<string, unknown>) : null;
  }
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return refuse('format', 'The JSON does not describe a transaction.');
  if ('types' in tx || 'primaryType' in tx || 'domain' in tx)
    return refuse('signature', 'This is typed data to sign, not a transaction. Signatures are not supported here yet.');

  const chainId = parseChainId(tx.chainId);
  if (chainId === null) return refuse('chain', 'The request has no valid chainId, so the chain it runs on is unknown.');
  if (typeof tx.to !== 'string' || !isAddress(tx.to, { strict: false })) return refuse('address', 'The request has no valid "to" address.');
  if (tx.from !== undefined && (typeof tx.from !== 'string' || !isAddress(tx.from, { strict: false })))
    return refuse('address', 'The "from" address is not valid.');
  const data = typeof tx.data === 'string' ? tx.data : typeof tx.input === 'string' ? tx.input : '';
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length < 10) return refuse('data', 'The request carries no contract call data.');
  const value = parseQuantity(tx.value);
  if (value === null) return refuse('format', 'The "value" field is not a valid amount.');
  return {
    ok: true,
    request: {
      source: 'json',
      chainId,
      from: typeof tx.from === 'string' ? getAddress(tx.from) : null,
      to: getAddress(tx.to),
      data: data.toLowerCase() as Hex,
      value,
    },
  };
}

// ---- what the request does -----------------------------------------------------------------------------------------

export type VerifiedToken = { chain: EvmChain; chainId: number; address: Address; symbol: string; decimals: number };
export type KnownSpender = { chainId: number; address: Address; label: string };

/** The tokens and Anonymo contracts the gateway vouches for, per chain. Everything else is unverified. */
export function verifiedFromContracts(contracts: DepositContracts | null, chainIdOf: (chain: EvmChain) => number) {
  const tokens: VerifiedToken[] = [];
  const spenders: KnownSpender[] = [];
  if (contracts && !contracts.paused) {
    for (const c of contracts.chains) {
      const chainId = c.chain_id ?? chainIdOf(c.chain);
      spenders.push({ chainId, address: getAddress(c.router), label: 'Anonymo deposit router' });
      for (const t of c.tokens) tokens.push({ chain: c.chain, chainId, address: getAddress(t.address), symbol: t.symbol, decimals: t.decimals });
    }
    const coin = contracts.coin;
    if (coin) {
      tokens.push({ chain: 'rhc', chainId: coin.chain_id, address: getAddress(coin.token.address), symbol: coin.token.symbol, decimals: coin.token.decimals });
      spenders.push({ chainId: coin.chain_id, address: getAddress(coin.coin_pay), label: 'Anonymo CoinPay' });
    }
  }
  return { tokens, spenders };
}

export type ApprovalReview = {
  kind: 'approval';
  /** Changes whenever anything that matters changes, so an older simulation can be recognised as stale. */
  fingerprint: string;
  request: WalletRequest;
  chain: { id: number; name: string; supported: boolean; key: EvmChain | null };
  token: { address: Address; verified: VerifiedToken | null };
  spender: { address: Address; label: string | null };
  account: Address | null;
  amount: { raw: bigint; unlimited: boolean; zero: boolean; text: string };
  /** Native coin sent along with the approval (should be zero). */
  value: bigint;
};

export type Networks = { chain: EvmChain; chainId: number; name: string }[];

export function fingerprintOf(r: WalletRequest) {
  return [r.chainId, r.from ?? '-', r.to, r.data, r.value.toString()].join('|').toLowerCase();
}

/** The amount in words: verified decimals when known, else the raw integer with its unit named. */
export function amountText(raw: bigint, token: VerifiedToken | null): string {
  if (raw === maxUint256) return token ? `Unlimited ${token.symbol}` : 'Unlimited';
  if (!token) return `${raw.toString()} units (decimals unknown)`;
  return `${formatUnits(raw, token.decimals, token.decimals)} ${token.symbol}`;
}

export function reviewRequest(
  request: WalletRequest,
  ctx: { networks: Networks; tokens: VerifiedToken[]; spenders: KnownSpender[] },
): { ok: true; review: ApprovalReview } | RequestRefusal {
  if (request.data.slice(0, 10).toLowerCase() !== APPROVE)
    return refuse('call', 'This transaction is not a token approval. Only approvals can be reviewed so far.');
  let spender: Address;
  let raw: bigint;
  try {
    const decoded = decodeFunctionData({ abi: ERC20_PERMIT_ABI, data: request.data });
    if (decoded.functionName !== 'approve') throw new Error('not approve');
    [spender, raw] = decoded.args as readonly [Address, bigint];
  } catch {
    return refuse('data', 'The approval data could not be decoded. Do not sign a request that cannot be read.');
  }
  const network = ctx.networks.find(n => n.chainId === request.chainId) ?? null;
  const verified = network ? ctx.tokens.find(t => t.chainId === request.chainId && t.address.toLowerCase() === request.to.toLowerCase()) ?? null : null;
  const known = ctx.spenders.find(s => s.chainId === request.chainId && s.address.toLowerCase() === spender.toLowerCase()) ?? null;
  return {
    ok: true,
    review: {
      kind: 'approval',
      fingerprint: fingerprintOf(request),
      request,
      chain: { id: request.chainId, name: network?.name ?? `Chain ${request.chainId}`, supported: !!network, key: network?.chain ?? null },
      token: { address: request.to, verified },
      spender: { address: getAddress(spender), label: known?.label ?? null },
      account: request.from,
      amount: { raw, unlimited: raw === maxUint256, zero: raw === 0n, text: amountText(raw, verified) },
      value: request.value,
    },
  };
}

/** The same approval with a smaller limit. Illustrative only: the wallet must allow the edit, and the person checks it there. */
export function limitedPreview(review: ApprovalReview, wholeTokens: bigint): { data: Hex; text: string } | null {
  const token = review.token.verified;
  if (!token) return null;
  const raw = wholeTokens * 10n ** BigInt(token.decimals);
  if (!review.amount.unlimited && review.amount.raw <= raw) return null;
  return {
    data: encodeFunctionData({ abi: ERC20_PERMIT_ABI, functionName: 'approve', args: [review.spender.address, raw] }),
    text: amountText(raw, token),
  };
}

// ---- optional read-only simulation --------------------------------------------------------------------------------

export type Simulation =
  | { kind: 'ok'; fingerprint: string; at: number; currentAllowance: bigint; allowanceAfter: bigint; balanceChange: bigint; nativeChange: bigint }
  | { kind: 'unsupported'; fingerprint: string; at: number; message: string }
  | { kind: 'failed'; fingerprint: string; at: number; message: string };

/** A simulation answers for one exact request at one moment. A changed request, or two minutes, makes it stale. */
export const SIMULATION_FRESH_MS = 2 * 60_000;
export const isStale = (s: Simulation, review: ApprovalReview, now: number) => s.fingerprint !== review.fingerprint || now - s.at > SIMULATION_FRESH_MS;

/** Exactly what a simulation sends, shown to the person before they choose to run it. */
export function simulationDisclosure(review: ApprovalReview, rpcUrl: string, account: Address) {
  return {
    host: hostOf(rpcUrl),
    fields: [
      ['Your wallet address', account],
      ['Token contract', review.token.address],
      ['Spender', review.spender.address],
      ['Amount', review.amount.raw.toString()],
      ['Chain', String(review.chain.id)],
    ] as [string, string][],
  };
}

export function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/** JSON-RPC over fetch. Only the two read methods below are ever called. */
export function rpcClient(rpcUrl: string, fetcher: typeof fetch = fetch): Rpc {
  let id = 0;
  return async (method, params) => {
    if (method !== 'eth_call' && method !== 'eth_simulateV1') throw new Error(`Refusing ${method}: simulation is read-only.`);
    const res = await fetcher(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
    if (body.error) throw Object.assign(new Error(body.error.message ?? 'RPC error'), { code: body.error.code });
    return body.result;
  };
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL_TOPIC = toEventSelector('Approval(address,address,uint256)');
const topicAddress = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

/** Ask an RPC what this exact request would do, without sending it. Never throws: every outcome is a state. */
export async function simulateApproval(review: ApprovalReview, account: Address, rpc: Rpc, now: () => number = Date.now): Promise<Simulation> {
  const fingerprint = review.fingerprint;
  const token = review.token.address;
  const owner = account.toLowerCase();
  let currentAllowance: bigint;
  try {
    const out = await rpc('eth_call', [{ to: token, data: encodeFunctionData({ abi: ERC20_PERMIT_ABI, functionName: 'allowance', args: [account, review.spender.address] }) }, 'latest']);
    currentAllowance = BigInt(out as string);
  } catch (e) {
    return { kind: 'failed', fingerprint, at: now(), message: `The token did not answer an allowance read (${(e as Error).message}). It may not be an ERC-20 token on this chain.` };
  }
  let result: unknown;
  try {
    result = await rpc('eth_simulateV1', [{
      blockStateCalls: [{ calls: [{ from: account, to: token, data: review.request.data, value: `0x${review.request.value.toString(16)}` }] }],
      traceTransfers: true,
      validation: false,
    }, 'latest']);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === -32601 || code === -32600 || /not (found|supported|available)|does not exist|unknown method/i.test((e as Error).message))
      return { kind: 'unsupported', fingerprint, at: now(), message: 'This network’s public RPC cannot simulate transactions, so the immediate balance change is not known.' };
    return { kind: 'failed', fingerprint, at: now(), message: `The simulation did not complete: ${(e as Error).message}` };
  }
  const call = (result as { calls?: { status?: string; logs?: { address: string; topics: string[]; data: string }[]; error?: { message?: string } }[] }[] | undefined)?.[0]?.calls?.[0];
  if (!call) return { kind: 'unsupported', fingerprint, at: now(), message: 'The RPC returned no simulation result for this request.' };
  if (call.status !== '0x1') return { kind: 'failed', fingerprint, at: now(), message: `The request would fail on chain${call.error?.message ? `: ${call.error.message}` : '.'}` };
  let balanceChange = 0n;
  let nativeChange = 0n;
  let allowanceAfter = currentAllowance;
  for (const log of call.logs ?? []) {
    const [topic, a, b] = log.topics ?? [];
    const amount = log.data && log.data !== '0x' ? BigInt(log.data.slice(0, 66)) : 0n;
    if (topic === TRANSFER_TOPIC && a && b) {
      const isToken = log.address.toLowerCase() === token.toLowerCase();
      const native = /^0x0*e+$/i.test(log.address); // traceTransfers reports native moves from 0xeeee…
      const delta = (topicAddress(b) === owner ? amount : 0n) - (topicAddress(a) === owner ? amount : 0n);
      if (isToken) balanceChange += delta;
      else if (native) nativeChange += delta;
    }
    if (topic === APPROVAL_TOPIC && log.address.toLowerCase() === token.toLowerCase() && a && topicAddress(a) === owner) allowanceAfter = amount;
  }
  return { kind: 'ok', fingerprint, at: now(), currentAllowance, allowanceAfter, balanceChange, nativeChange };
}

/** Wallet methods this feature must never call. The browser check spies on the injected provider for these. */
export const FORBIDDEN_WALLET_METHODS = ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'eth_signTransaction', 'wallet_sendCalls'];
