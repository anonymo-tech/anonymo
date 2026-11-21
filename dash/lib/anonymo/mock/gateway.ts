// An in-browser stand-in for the Anonymo gateway, used in demo mode and by the dash checks. It answers the same paths
// with the same shapes as the real gateway (lib/anonymo/types.ts names the gateway route behind each), keeps state per
// key, streams chat as SSE, and signs nothing for real: receipts and proofs are structurally valid (the Merkle path
// verifies) but the signature is a placeholder. It never sends anything over the network.

import { API_PATHS } from '../client.ts';
import { musdToUsdString, usdToMusd } from '../money.ts';
import { hashPair, keccakHex } from '../proof.ts';
import type {
  Balance,
  ChatChunk,
  ChatRequest,
  CoinInstructions,
  CouncilResult,
  CreateKeyResponse,
  DepositChain,
  DepositInstructions,
  DepositRow,
  KeyCaps,
  KeyCapsInput,
  PayoutChain,
  ProofView,
  Receipt,
  ReceiptRoute,
  ReceiptView,
  SpendGroup,
  SpendPeriod,
  Withdrawal,
} from '../types.ts';
import { DEMO_IMAGE_MODELS, DEMO_NUDITY } from './images.ts';
import { demoFaceReply, demoPicture } from './faces.ts';
import { demoMemoryReply, demoRememberedReply } from './memory.ts';
import { RECAP_INSTRUCTION } from '../catchup.ts';
import { moveInReply, withTextPrices } from './movein.ts';
import { demoStatus } from './status.ts';
import { DEMO_TRANSCRIPT, DEMO_VOICE_MODELS, DEMO_VOICE_REPLY, demoTranscription } from './talk.ts';
import { demoStoryReply } from './story.ts';
import { expiredKeyRefusal } from './tickets.ts';
import { createDemoVideo } from './video.ts';
import { createDemoSpeech, demoStoryReply as bedtimeStoryReply, DEMO_SPEECH_MODELS } from './voice.ts';
import { activityCsv, runway, sampleHistory, spendReport, spentWindows, type UsageEntry } from './usage.ts';
import { COUNCIL_MERGED, DEMO_ANMO, DEMO_COIN_PAY, DEMO_LEADERBOARD, DEMO_MANIFEST, DEMO_MODELS, DEMO_PRICES, DEMO_ROUTER, DEMO_ROUTES, DEMO_VIDEO_MODELS, demoReply } from './fixtures.ts';
import { sideBySideReply } from './sidebyside.ts';

type Row = DepositRow & { musd: number };
type KeyState = {
  keyHash: string;
  caps: KeyCaps;
  keyCommit: string;
  balance: number; // micro-USD
  held: number;
  usageOnly: number; // ANMO credit: spendable on usage, never withdrawable
  deposits: Row[];
  withdrawals: (Withdrawal & { musd: number; idem: string })[];
  characters: string[];
  /** What this key spent (update "usage"); older saved demo state has none. */
  usage?: UsageEntry[];
};
type StoredReceipt = { view: Omit<ReceiptView, 'anchor'>; hourLeaves: string[] };
type State = { v: 2; keys: Record<string, KeyState>; receipts: Record<string, StoredReceipt> };

export type MockOptions = {
  /** Where state survives a page reload. `null` keeps it in memory only. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Delay between streamed chunks, in ms. */
  delayMs?: number;
  /** When false, anonymo-sealed answers 409 sealed_unavailable (no attested route is up). */
  sealedAvailable?: boolean;
  /** The ANMO price in USD for the coin rail; null = coin payments unavailable; undefined = the demo price. */
  coinPriceUsd?: string | null;
  /** How long an image takes, in ms (the real models take 10–40 s). */
  imageDelayMs?: number;
  /** Clock for demo video jobs. */
  videoNow?: () => number;
  /** How long a demo speech clip takes, in ms. */
  speechDelayMs?: number;
};

const STORAGE_KEY = 'anonymo.demo.state.v2';
const enc = new TextEncoder();
const WITHDRAW_MIN = 1_000_000;

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const randomB58 = (n: number) => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join('');
};

async function sha256Hex(input: string | Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', typeof input === 'string' ? enc.encode(input) : input);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function walletFor(chain: DepositChain): string {
  switch (chain) {
    case 'solana':
      return randomB58(44);
    case 'tron':
      return `T${randomB58(33)}`;
    case 'btc':
      return `bc1q${randomHex(19).slice(0, 38)}`;
    case 'ln':
      return 'demo-payer@ln.example';
    default:
      return `0x${randomHex(20)}`;
  }
}

const usd = (musd: number) => Number(musdToUsdString(musd));

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
/** The gateway's error shape: `code` is the status, `type` the machine code. */
const fail = (status: number, type: string, message: string, metadata?: Record<string, unknown>) =>
  json({ error: { code: status, message, type, ...(metadata ? { metadata } : {}) } }, status);

const tokensOf = (text: string) => Math.max(1, Math.ceil(text.length / 4));

const capsOut = (input: KeyCapsInput = {}): KeyCaps => ({
  daily_usd: input.daily_usd == null ? null : Number(input.daily_usd),
  monthly_usd: input.monthly_usd == null ? null : Number(input.monthly_usd),
  lifetime_usd: input.lifetime_usd == null ? null : Number(input.lifetime_usd),
  models: input.models ?? null,
  ip_allow: input.ip_allow ?? null,
  sealed_only: input.sealed_only ?? false,
  expires_at: input.expires_at ?? null,
});

export function createMockGateway(options: MockOptions = {}) {
  const storage = options.storage === undefined ? null : options.storage;
  const delayMs = options.delayMs ?? 18;
  const coinPrice = options.coinPriceUsd === undefined ? '0.0125' : options.coinPriceUsd;
  let state: State = { v: 2, keys: {}, receipts: {} };
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    const parsed = saved ? (JSON.parse(saved) as State) : null;
    if (parsed?.v === 2) state = parsed;
  } catch {
    state = { v: 2, keys: {}, receipts: {} };
  }
  const persist = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage full or blocked: keep going in memory
    }
  };

  async function keyState(request: Request): Promise<KeyState | Response> {
    const auth = request.headers.get('authorization') ?? '';
    const key = /^Bearer (anm_(?:live|test)_[A-Za-z0-9_-]+)$/.exec(auth)?.[1];
    if (!key) return fail(401, 'unauthorized', 'Missing or malformed API key.');
    const found = state.keys[await sha256Hex(key)];
    return found ?? fail(401, 'unauthorized', 'Unknown API key.');
  }

  function instructions(k: KeyState): DepositInstructions {
    const coin: CoinInstructions = {
      chain: 'rhc',
      chain_id: 4663,
      coin_pay: DEMO_COIN_PAY,
      token: { symbol: 'ANMO', address: DEMO_ANMO, decimals: 18 },
      price_usd: coinPrice,
      max_usd_per_payment: '250',
      confirmations: 3,
      key_commit: k.keyCommit as `0x${string}`,
      method: 'pay(uint256 amount, bytes32 keyCommit)',
      credited_at: 'the USD value at the time of crediting',
    };
    return {
      paused: false,
      evm: {
        key_commit: k.keyCommit as `0x${string}`,
        method: 'deposit(address token, uint256 amount, bytes32 keyCommit)',
        chains: [
          { chain: 'rhc', router: DEMO_ROUTER, confirmations: 3, tokens: [{ symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 }] },
          {
            chain: 'base',
            router: DEMO_ROUTER,
            confirmations: 12,
            tokens: [{ symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 }],
          },
        ],
      },
      solana: null,
      tron: null,
      btc: { invoice: 'POST /deposits/btcpay {amount_usd, refund_address}', credited_at: 'the BTCPay quote' },
      coin,
      stablecoins_credit: '1:1 USD',
    };
  }

  /** What each source can take back: what came from it less what went back, capped at the withdrawable balance. */
  function withdrawTo(k: KeyState): Balance['withdraw_to'] {
    const withdrawable = Math.max(0, k.balance - k.held - k.usageOnly);
    const out = new Map<string, { chain: PayoutChain; address: string; remaining: number }>();
    for (const d of k.deposits) {
      if (d.status !== 'credited' || d.chain === 'coin') continue;
      const id = `${d.chain}|${d.from}`;
      const cur = out.get(id) ?? { chain: d.chain as PayoutChain, address: d.from, remaining: 0 };
      cur.remaining += d.musd;
      out.set(id, cur);
    }
    for (const w of k.withdrawals) {
      const cur = out.get(`${w.chain}|${w.to}`);
      if (cur) cur.remaining -= w.musd;
    }
    return [...out.values()].map((d) => ({ chain: d.chain, address: d.address, max_usd: usd(Math.max(0, Math.min(d.remaining, withdrawable))) }));
  }

  function balanceOf(k: KeyState): Balance {
    return {
      balance_usd: usd(k.balance),
      held_usd: usd(k.held),
      available_usd: usd(Math.max(0, k.balance - k.held)),
      usage_only_usd: usd(k.usageOnly),
      withdraw_to: withdrawTo(k),
    };
  }

  function spend(k: KeyState, musd: number, use?: Omit<UsageEntry, 'at' | 'musd'>) {
    k.balance -= musd;
    k.usageOnly = Math.max(0, k.usageOnly - musd); // usage-only credit is spent first
    if (use) (k.usage ??= []).push({ ...use, at: Date.now(), musd });
  }

  /** The key's caps, checked like the gateway's capsVerdict (402 key_cap_reached once a window is used up). */
  function capRefusal(k: KeyState): Response | null {
    const spent = spentWindows(k.usage ?? [], Date.now());
    const windows = [
      [k.caps.daily_usd, spent.day, 'daily'],
      [k.caps.monthly_usd, spent.month, 'monthly'],
      [k.caps.lifetime_usd, spent.life, 'lifetime'],
    ] as const;
    for (const [cap, used, name] of windows)
      if (cap !== null && used >= usdToMusd(String(cap))) return fail(402, 'key_cap_reached', `This key reached its ${name} spend cap of $${cap}.`);
    return null;
  }

  const video = createDemoVideo<KeyState>({
    json, fail, now: options.videoNow ?? Date.now, id: () => `vid_demo_${randomHex(12)}`,
    check: (k, cost) => k.balance - k.held < cost ? fail(402, 'insufficient_balance', 'Not enough credit for this request.') : capRefusal(k),
    charge: (k, cost, job) => { spend(k, cost, { model: job.model, kind: 'call', requestId: job.id }); persist(); },
  });

  // Update "voice": demo speech for Night Call (mock/voice.ts), checked and charged like any other call.
  const speech = createDemoSpeech<KeyState>({
    fail, id: () => `med_demo_${randomHex(12)}`, delayMs: options.speechDelayMs,
    check: (k, cost) => k.balance - k.held < cost ? fail(402, 'insufficient_balance', 'Not enough credit for this request.') : capRefusal(k),
    charge: (k, cost, model, requestId) => { spend(k, cost, { model, kind: 'call', requestId }); persist(); },
  });

  /** Sample history plus what the key really spent, for the usage reports. */
  const usageOf = (k: KeyState) => [...sampleHistory(k.keyHash, Date.now()), ...(k.usage ?? [])];

  async function patchCaps(request: Request, k: KeyState) {
    const body = (await request.json().catch(() => null)) as KeyCapsInput | null;
    if (!body || typeof body !== 'object') return fail(400, 'invalid_request', 'Send the caps as a JSON object.');
    const money = (v: unknown) => v === null || (typeof v === 'number' && v >= 0) || (typeof v === 'string' && /^\d{1,12}(\.\d{1,12})?$/.test(v));
    for (const f of ['daily_usd', 'monthly_usd', 'lifetime_usd'] as const)
      if (f in body && !money(body[f])) return fail(400, 'invalid_request', `${f} must be a dollar amount or null.`);
    const next = capsOut({ ...k.caps, ...body });
    k.caps = { ...next, ...(k.caps.wallet !== undefined ? { wallet: k.caps.wallet } : {}) };
    persist();
    return json({ key_hash: k.keyHash, caps: k.caps });
  }

  /** Demo-only: credit a stablecoin deposit as if the watcher had confirmed it (stands in for DepositSink.credit). */
  async function simulateDeposit(key: string, chain: PayoutChain, token: string, amountMusd: number) {
    const k = state.keys[await sha256Hex(key)];
    if (!k) throw new Error('Unknown key.');
    if (!Number.isSafeInteger(amountMusd) || amountMusd <= 0) throw new Error('Amount must be positive.');
    const prior = k.deposits.find((d) => d.chain === chain);
    const from = prior?.from ?? walletFor(chain);
    const ref = `${chain}:0x${randomHex(32)}:0`;
    k.deposits.unshift({ ref, chain, token, amount_usd: usd(amountMusd), musd: amountMusd, from, status: 'credited', created_at: new Date().toISOString() });
    k.balance += amountMusd;
    persist();
    return ref;
  }

  /** Demo-only: credit an ANMO payment (usage-only). Above the per-payment cap it is held, as the gateway does. */
  async function simulateCoinPayment(key: string, amountMusd: number) {
    const k = state.keys[await sha256Hex(key)];
    if (!k) throw new Error('Unknown key.');
    const over = amountMusd > 250_000_000;
    const ref = `coin:0x${randomHex(32)}:0`;
    k.deposits.unshift({
      ref,
      chain: 'coin',
      token: 'ANMO',
      amount_usd: usd(amountMusd),
      musd: amountMusd,
      from: walletFor('rhc'),
      status: over ? 'held' : 'credited',
      created_at: new Date().toISOString(),
      ...(over ? { reason: 'over_cap' } : {}),
    });
    if (!over) {
      k.balance += amountMusd;
      k.usageOnly += amountMusd;
    }
    persist();
    return ref;
  }

  async function createKey(request: Request) {
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { caps?: KeyCapsInput };
    const key = `anm_live_${randomHex(32)}`;
    const keyHash = await sha256Hex(key);
    const k: KeyState = {
      keyHash,
      caps: capsOut(body.caps),
      keyCommit: keccakHex(enc.encode(`anonymo-deposit-v1:${keyHash}`)),
      balance: 0,
      held: 0,
      usageOnly: 0,
      deposits: [],
      withdrawals: [],
      characters: [],
    };
    state.keys[keyHash] = k;
    persist();
    const response: CreateKeyResponse = { key, key_hash: keyHash, wallet: null, caps: k.caps, deposit: instructions(k) };
    return json(response, 201);
  }

  async function withdraw(request: Request, k: KeyState) {
    const idem = request.headers.get('idempotency-key') ?? '';
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idem))
      return fail(400, 'idempotency_key_required', 'Send an Idempotency-Key header so a retry never withdraws twice.');
    const body = (await request.json().catch(() => null)) as { chain?: string; to?: string; token?: string; amount_usd?: string } | null;
    if (!body?.chain || !body.to) return fail(400, 'invalid_request', 'Invalid request: chain and to are required.');
    const prior = k.withdrawals.find((w) => w.idem === idem);
    if (prior) {
      const { musd: _m, idem: _i, ...w } = prior;
      return json({ withdrawal: w, replay: true }, 200);
    }
    const dest = withdrawTo(k).find((d) => d.chain === body.chain && d.address === body.to);
    if (!dest)
      return fail(403, 'not_source_address', "Withdrawals go only to an address this key's deposits came from, on the same chain.", {
        allowed: withdrawTo(k).map((d) => ({ chain: d.chain, address: d.address })),
      });
    const cap = usdToMusd(dest.max_usd);
    const amount = body.amount_usd === undefined || body.amount_usd === 'all' ? cap : usdToMusd(body.amount_usd);
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail(402, 'nothing_to_withdraw', 'Nothing is available to withdraw to this address.');
    if (amount > cap) return fail(403, 'exceeds_source', `At most $${musdToUsdString(cap)} can go back to this address.`);
    if (amount < WITHDRAW_MIN) return fail(400, 'below_minimum', 'The smallest withdrawal is $1.');
    const token = body.token ?? k.deposits.find((d) => d.chain === body.chain && d.from === body.to)?.token ?? 'USDC';
    const now = new Date().toISOString();
    const w = {
      id: `wd_${randomHex(8)}`,
      status: 'sent' as const,
      chain: dest.chain,
      token,
      to: dest.address,
      amount_usd: usd(amount),
      tx: dest.chain === 'ln' ? `ln:${randomHex(16)}` : `0x${randomHex(32)}`,
      created_at: now,
      sent_at: now,
    };
    k.withdrawals.unshift({ ...w, musd: amount, idem });
    k.balance -= amount;
    persist();
    return json({ withdrawal: w, replay: false }, 202);
  }

  function storeReceipt(receipt: Receipt) {
    const leaf = keccakHex(enc.encode(JSON.stringify(receipt)));
    // Other receipts in the same hour, so the inclusion path is a real multi-level path.
    const hourLeaves = Array.from({ length: 6 }, () => `0x${randomHex(32)}`);
    hourLeaves.splice(Math.floor(Math.random() * 7), 0, leaf);
    const sig = btoa(randomHex(32));
    state.receipts[receipt.request_id] = {
      view: { id: receipt.request_id, receipt, sig, key_id: 'demo0000demo0000', alg: 'Ed25519', leaf: leaf as `0x${string}`, header: '', signature_valid: false, keys: '/api/v1/receipts/keys' },
      hourLeaves,
    };
    return { payload: receipt, sig, key_id: 'demo0000demo0000', alg: 'Ed25519' as const, leaf: leaf as `0x${string}` };
  }

  const routeEntry = (id: string, role: ReceiptRoute['role'], musd: number, tokens: { in: number; out: number }, status: ReceiptRoute['status'], sealed: boolean): ReceiptRoute => {
    const r = DEMO_ROUTES.find((x) => x.id === id) ?? DEMO_ROUTES[0];
    return {
      route: r.id,
      role,
      provider: r.upstream,
      model: r.model,
      family: r.family,
      quant: r.quant,
      attested: r.attested,
      weights_hash: r.weights_hash,
      ...(sealed && r.attested ? { attestation_quote_hash: keccakHex(enc.encode(`demo-quote:${r.id}`)) } : {}),
      tokens,
      cost: musdToUsdString(musd),
      refused: status === 'refused',
      status,
    };
  };

  async function chat(request: Request, k: KeyState) {
    const body = (await request.json().catch(() => null)) as (ChatRequest & { stream?: boolean; council?: { mode?: string } }) | null;
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0)
      return fail(400, 'invalid_request', 'Invalid request: model and messages are required.');
    const model = body.model;
    const price = DEMO_PRICES[model];
    if (!price && !DEMO_MODELS.some((m) => m.id === model)) return fail(404, 'model_not_found', `Model ${model.slice(0, 80)} is not available.`);
    if (model === 'anonymo-council' && body.stream === true) return fail(400, 'streaming_unsupported', 'Council mode does not support streaming. Send stream: false.');
    const sealed = model === 'anonymo-sealed' || request.headers.get('x-anonymo-sealed') === 'required';
    if (k.caps.sealed_only && !sealed) return fail(403, 'sealed_only', 'This key is sealed-only: use model anonymo-sealed.');
    if (sealed && options.sealedAvailable === false)
      return fail(409, 'sealed_unavailable', 'No attested route with a fresh verified attestation can serve this sealed request. Nothing was sent or charged.', { sealed: true });
    const promptText = body.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const tin = tokensOf(promptText);
    const p = price ?? DEMO_PRICES['anonymo-1'];
    const maxCost = Math.ceil((tin * p.in + 900 * p.out) / 1_000_000);
    if (k.balance - k.held < maxCost) return fail(402, 'insufficient_balance', 'Not enough credit for this request.');
    const capped = capRefusal(k);
    if (capped) return capped;

    const requestId = `gen-${Math.floor(Date.now() / 1000)}-${randomHex(7)}`;
    const ts = new Date().toISOString();
    const storyText = demoStoryReply(body.messages);
    const memoryReply = demoMemoryReply(body.messages) ?? demoRememberedReply(body.messages);

    if (model === 'anonymo-council') {
      const mode = body.council?.mode === 'select' ? 'select' : 'merge';
      const picks = [DEMO_ROUTES[0], DEMO_ROUTES[3], DEMO_ROUTES[6]];
      const each = Math.ceil((tin * 450_000 + 60 * 1_800_000) / 1_000_000);
      const aggCost = Math.ceil((tin * 3 * p.in + 200 * p.out) / 1_000_000);
      const text = storyText ?? memoryReply ?? (mode === 'select' ? demoReply('anonymo-1') : COUNCIL_MERGED);
      const routes = [
        ...picks.map((r) => routeEntry(r.id, 'proposer', each, { in: tin, out: 60 }, 'ok', false)),
        routeEntry(DEMO_ROUTES[1].id, mode === 'merge' ? 'aggregator' : 'judge', aggCost, { in: tin * 3, out: tokensOf(text) }, 'ok', false),
      ];
      const cost = routes.reduce((s, r) => s + usdToMusd(r.cost), 0);
      const receipt: Receipt = {
        v: 'anonymo-receipt/1',
        request_id: requestId,
        model_id: model,
        routes,
        weights_hash: routes.map((r) => r.weights_hash),
        tokens: { in: routes.reduce((s, r) => s + r.tokens.in, 0), out: routes.reduce((s, r) => s + r.tokens.out, 0) },
        cost: musdToUsdString(cost),
        refused: false,
        sealed: false,
        council: { mode, outcome: mode === 'merge' ? 'merged' : 'selected', selected: mode === 'select' ? 'A' : null, proposers: 3, answered: 3 },
        ts,
      };
      spend(k, cost, { model, kind: 'call', requestId });
      const seat = (r: ReceiptRoute) => ({ model: r.model, provider: r.provider, status: r.status, cost: r.cost, receipt_id: `${requestId}-${r.route}` });
      const council: CouncilResult = {
        mode,
        outcome: mode === 'merge' ? 'merged' : 'selected',
        selected: mode === 'select' ? 'A' : null,
        sealed: false,
        proposers: routes.slice(0, 3).map((r, i) => ({ label: String.fromCharCode(65 + i), family: r.family, ...seat(r) })),
        [mode === 'merge' ? 'aggregator' : 'judge']: seat(routes[3]),
        premium: '0',
        total_cost: musdToUsdString(cost),
      };
      const signed = storeReceipt(receipt);
      persist();
      return json(
        {
          id: requestId,
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          anonymo_receipt: signed,
          council,
        },
        200,
        { 'x-anonymo-council-mode': mode },
      );
    }

    // Hold at the maximum cost, settle to the actual cost when the stream ends.
    k.held += maxCost;
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const rerouted = !storyText && model === 'anonymo-1' && /\breroute\b/i.test(lastUser);
    const servers = DEMO_ROUTES.filter((r) => (sealed ? r.attested && r.serves.includes('anonymo-sealed') : r.serves.includes(model) || r.model === model));
    const first = servers[0] ?? DEMO_ROUTES[0];
    const other = servers.find((r) => r.family !== first.family) ?? DEMO_ROUTES[2];
    let text = storyText ?? (lastUser === DEMO_TRANSCRIPT ? DEMO_VOICE_REPLY : demoReply(model));
    // Update "sidebyside": a direct model id answers in its own words, and a merge request gets a merged reply.
    if (!storyText) text = sideBySideReply(model, body.messages, text);
    // Update "catchup": a recap request gets recap-shaped notes built from what the person said.
    if (typeof lastUser === 'string' && lastUser === RECAP_INSTRUCTION) {
      const said = body.messages.filter((m) => m.role === 'user' && m.content !== RECAP_INSTRUCTION).map((m) => (typeof m.content === 'string' ? m.content : ''));
      text = `Recap so far (demo: a real model writes this from the whole chat).\n\n${said.map((s) => `- ${s.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n\n')}\n\nWhere it stands: the last point above. Keep the same tone and pick up from there.`;
    } else if (!storyText) {
      // Update "faces": a look or scene sentence for those requests, and an in-character line in a character chat.
      text = memoryReply ?? demoFaceReply(body.messages) ?? text;
    }
    // Update "voice": the Night Call bedtime starter, and each "keep reading" after it, gets the next part of a story.
    text = bedtimeStoryReply(body.messages) ?? text; // Night Call's bedtime starter
    // Update "movein": a memory request (a running summary, or the facts) gets a memory-shaped answer.
    text = moveInReply(body.messages) ?? text;
    if (rerouted) text = `The first route refused this, so the router retried on a different model family (${other.family}) and billed the refused attempt nothing. ${text}`;

    const chunks = text.match(/\S+\s*/g) ?? [text];
    const signal = request.signal;
    const finish = (delivered: string) => {
      const tout = tokensOf(delivered);
      const cost = Math.min(maxCost, Math.ceil((tin * p.in + tout * p.out) / 1_000_000));
      k.held -= maxCost;
      spend(k, cost, { model, kind: 'call', requestId });
      const served = rerouted ? other : first;
      const routes = [
        ...(rerouted ? [routeEntry(first.id, 'single', 0, { in: 0, out: 0 }, 'refused', sealed)] : []),
        routeEntry(served.id, rerouted ? 'retry' : 'single', cost, { in: tin, out: tout }, 'ok', sealed),
      ];
      const receipt: Receipt = {
        v: 'anonymo-receipt/1',
        request_id: requestId,
        model_id: model,
        routes,
        weights_hash: routes.map((r) => r.weights_hash),
        ...(sealed ? { attestation_quote_hash: keccakHex(enc.encode(`demo-quote:${requestId}`)) } : {}),
        tokens: { in: tin, out: tout },
        cost: musdToUsdString(cost),
        refused: false,
        sealed,
        ts,
      };
      const signed = storeReceipt(receipt);
      persist();
      return signed;
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (chunk: ChatChunk) => controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        let sent = '';
        try {
          controller.enqueue(enc.encode(': ANONYMO PROCESSING\n\n'));
          send({ id: requestId, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
          for (const piece of chunks) {
            if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
            await new Promise((r) => setTimeout(r, delayMs));
            sent += piece;
            send({ id: requestId, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: piece } }] });
          }
          send({ id: requestId, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          send({ id: requestId, object: 'chat.completion.chunk', model, choices: [], anonymo_receipt: finish(sent) });
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        } catch {
          // Charged only for the tokens delivered.
          finish(sent);
          try {
            controller.close();
          } catch {
            // already closed by the reader
          }
        }
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-receipt-id': requestId } });
  }

  function proofOf(id: string): Extract<ProofView, { rooted: true }> | null {
    const r = state.receipts[id];
    if (!r) return null;
    // Same construction as gateway/src/receipts/merkle.ts: sorted-pair keccak, odd node promoted.
    let layer = r.hourLeaves;
    const leafIndex = layer.indexOf(r.view.leaf);
    let index = leafIndex;
    const proof: `0x${string}`[] = [];
    while (layer.length > 1) {
      const sibling = index ^ 1;
      if (sibling < layer.length) proof.push(layer[sibling] as `0x${string}`);
      const next: string[] = [];
      for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i]);
      layer = next;
      index = Math.floor(index / 2);
    }
    return {
      id,
      rooted: true,
      posted: true,
      hour: Math.floor(Date.parse(r.view.receipt.ts) / 3_600_000),
      root: layer[0] as `0x${string}`,
      leaf: r.view.leaf,
      leaf_index: leafIndex,
      leaf_count: r.hourLeaves.length,
      proof,
      status: 'posted',
      tx_hash: `0x${randomHex(32)}`,
      valid: true,
      verify: { leaf: 'keccak256(canonical_json(receipt))', tree: 'sorted-pair keccak256 (OpenZeppelin MerkleProof)', contract: 'ReceiptRoots.rootOf(hour)' },
    };
  }

  // Images: priced like the gateway, refused like the gateway's nudity check, painted in the browser (demoImage).
  async function images(request: Request, k: KeyState) {
    const body = (await request.json().catch(() => null)) as { model?: string; prompt?: string; n?: number; size?: string } | null;
    const model = DEMO_IMAGE_MODELS.find((m) => m.id === body?.model);
    if (!model) return fail(404, 'model_not_found', 'Unknown image model. GET /v1/media/models lists them.');
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) return fail(400, 'invalid_request', 'Enter a prompt of 1–4,000 characters.');
    if (DEMO_NUDITY.test(prompt))
      return fail(451, 'explicit_media_unavailable', 'Anonymo makes no nude or sexual images or video. Nothing was sent or charged.', { stage: 'prompt' });
    const n = body?.n ?? 1;
    const maxImages = model.max_images ?? 4;
    if (!Number.isInteger(n) || n < 1 || n > maxImages) return fail(400, 'invalid_request', `n must be 1–${maxImages}.`);
    const size = body?.size ?? model.sizes[0];
    if (!model.sizes.includes(size)) return fail(400, 'invalid_request', `size must be one of ${model.sizes.join(', ')}.`);
    const cost = usdToMusd(model.pricing.usd_per_image) * n;
    if (k.balance - k.held < cost) return fail(402, 'insufficient_balance', 'Not enough credit for this request.');
    const capped = capRefusal(k);
    if (capped) return capped;
    const [w, h] = size.split('x').map(Number);
    const data = [];
    for (let i = 0; i < n; i++) data.push({ b64_json: await demoPicture(prompt, w, h, i, model.id) });
    const hashes = await Promise.all(data.map(({ b64_json }) => sha256Hex(Uint8Array.from(atob(b64_json), (c) => c.charCodeAt(0)))));
    await new Promise((r) => setTimeout(r, options.imageDelayMs ?? 1600));
    // Another image may have settled while this one was rendering.
    if (k.balance - k.held < cost) return fail(402, 'insufficient_balance', 'Not enough credit for this request.');
    const cappedAtSettlement = capRefusal(k);
    if (cappedAtSettlement) return cappedAtSettlement;
    const requestId = `img-${Math.floor(Date.now() / 1000)}-${randomHex(7)}`;
    const costUsd = musdToUsdString(cost);
    const receipt = {
      payload: {
        v: 1, kind: 'media', request_id: requestId, model_id: model.id,
        routes: [`demo:${model.id}`], media_units: n, unit: 'image', cost_usd: costUsd,
        outputs_sha256: hashes, provenance: 'demo', ts: new Date().toISOString(),
      },
      key_id: 'demo', sig: null,
    };
    spend(k, cost, { model: model.id, kind: 'image', requestId });
    persist();
    return json({ created: Math.floor(Date.now() / 1000), data, anonymo: { request_id: requestId, model: model.id, cost_usd: costUsd, provenance: { c2pa: true, watermark: true }, receipt } });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'GET' && path === API_PATHS.models) return json({ data: withTextPrices(DEMO_MODELS, DEMO_PRICES) });
    if (method === 'GET' && path === API_PATHS.manifest) return json(DEMO_MANIFEST);
    if (method === 'GET' && path === API_PATHS.leaderboard) return json(DEMO_LEADERBOARD);
    if (method === 'GET' && path === API_PATHS.statusSlo) return json({ data: demoStatus(Date.now()) });
    if (method === 'GET' && path === API_PATHS.health) return json({ ok: true });
    if (method === 'GET' && path === API_PATHS.mediaModels) return json({ object: 'list', data: [...DEMO_IMAGE_MODELS, ...DEMO_VIDEO_MODELS, ...DEMO_SPEECH_MODELS, ...DEMO_VOICE_MODELS.filter((m) => m.kind === 'transcription')] });
    const receiptMatch = /^\/v1\/receipts\/([^/]+)(\/proof)?$/.exec(path);
    if (method === 'GET' && receiptMatch) {
      const id = decodeURIComponent(receiptMatch[1]);
      const r = state.receipts[id];
      if (!r) return fail(404, 'not_found', 'Receipt not found.');
      const proof = proofOf(id);
      if (receiptMatch[2]) return json({ data: proof });
      const { id: _id, rooted: _r, posted: _p, verify: _v, ...anchor } = proof!;
      return json({ data: { ...r.view, anchor } });
    }
    if (method === 'POST' && path === API_PATHS.keys) return createKey(request);

    const k = await keyState(request);
    if (k instanceof Response) return k;
    const lapsed = expiredKeyRefusal(k.caps, Date.now(), fail);
    if (lapsed) return lapsed;
    if (method === 'GET' && path === API_PATHS.keyInfo) return json({ key_hash: k.keyHash, label: null, caps: k.caps, deposit: instructions(k) });
    if (method === 'GET' && path === API_PATHS.balance) return json(balanceOf(k));
    if (method === 'GET' && path === API_PATHS.deposits)
      return json({ instructions: instructions(k), data: k.deposits.map(({ musd: _m, ...d }) => d) });
    if (method === 'GET' && path === API_PATHS.withdrawals) return json({ data: k.withdrawals.map(({ musd: _m, idem: _i, ...w }) => w) });
    if (method === 'POST' && path === API_PATHS.btcpayInvoice) {
      const body = (await request.json().catch(() => null)) as { amount_usd?: string; refund_address?: string } | null;
      const amount = usdToMusd(body?.amount_usd ?? '');
      if (!Number.isSafeInteger(amount) || amount < 1_000_000) return fail(400, 'below_minimum', 'The smallest deposit is $1.');
      const refund = body?.refund_address ?? '';
      const ln = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(refund);
      if (!ln && !/^(bc1|[13])[A-Za-z0-9]{20,90}$/.test(refund))
        return fail(400, 'invalid_refund_address', 'refund_address must be a Bitcoin address or a Lightning address (name@host).');
      return json(
        { invoice_id: `inv_${randomHex(8)}`, checkout_link: null, amount_usd: body!.amount_usd, refund: { chain: ln ? 'ln' : 'btc', address: refund } },
        201,
      );
    }
    if (method === 'POST' && path === API_PATHS.withdraw) return withdraw(request, k);
    if (method === 'POST' && path === API_PATHS.chat) return chat(request, k);
    if (method === 'POST' && path === API_PATHS.images) return images(request, k);
    // One stock speech model in the demo, as in production: Night Call's mock serves it for both voice updates.
    if (method === 'POST' && path === API_PATHS.speech) return speech.speak(request, k);
    if (method === 'POST' && path === API_PATHS.transcriptions) return demoTranscription(request);
    if (method === 'POST' && path === API_PATHS.videos) return video.submit(request, k);
    if (method === 'GET' && path.startsWith(`${API_PATHS.videos}/`)) return video.status(path.slice(API_PATHS.videos.length + 1), k);
    if (method === 'PATCH' && path === API_PATHS.caps) return patchCaps(request, k);
    if (method === 'GET' && path === API_PATHS.spend) {
      const period = url.searchParams.get('period') ?? '30d';
      const group = url.searchParams.get('group_by') ?? 'day';
      if (!['7d', '30d', '90d'].includes(period) || !['day', 'model'].includes(group)) return fail(400, 'invalid_request', 'period is 7d, 30d or 90d; group_by is day or model.');
      return json({ data: spendReport(usageOf(k), period as SpendPeriod, group as SpendGroup, Date.now()) });
    }
    if (method === 'GET' && path === API_PATHS.runway) return json(runway(k.balance - k.held, usageOf(k), Date.now()));
    if (method === 'GET' && path === API_PATHS.activity) return new Response(activityCsv(usageOf(k)), { headers: { 'content-type': 'text/csv; charset=utf-8' } });
    if (method === 'POST' && path === API_PATHS.characters) {
      const body = (await request.json().catch(() => null)) as { sealed_card?: string; card_hash?: string; card?: unknown; png?: unknown } | null;
      if (body?.card || body?.png) return fail(400, 'plaintext_refused', 'A private card is encrypted on your device: send sealed_card and card_hash.');
      if (!body?.sealed_card || !body.card_hash) return fail(400, 'invalid_request', 'A private card needs sealed_card and card_hash.');
      const id = `ch_${randomHex(8)}`;
      k.characters.push(id);
      persist();
      return json({ data: { id, model: `@character/${id}`, visibility: 'private', card_hash: body.card_hash } }, 201);
    }
    return fail(404, 'not_found', `No route for ${method} ${path}.`);
  }

  const mockFetch = (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init));

  return { fetch: mockFetch as typeof fetch, simulateDeposit, simulateCoinPayment };
}

export type MockGateway = ReturnType<typeof createMockGateway>;
