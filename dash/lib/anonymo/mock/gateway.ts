// An in-browser stand-in for the Anonymo gateway, used in demo mode and by the dash checks. It answers the same
// paths with the same shapes as the real API (lib/anonymo/types.ts), keeps state per key, streams chat as SSE, and
// signs nothing for real: receipts and proofs are structurally valid (the Merkle path verifies) but the signature is
// a placeholder. It never sends anything over the network.

import { API_PATHS } from '../client.ts';
import { hashPair, keccakHex } from '../proof.ts';
import type {
  Balance,
  ChatChunk,
  ChatRequest,
  CouncilResult,
  CreateKeyRequest,
  CreateKeyResponse,
  DepositAddress,
  DepositChain,
  DepositSource,
  DepositToken,
  InclusionProof,
  LedgerKind,
  LightningInvoice,
  Receipt,
  SignedReceipt,
  Withdrawal,
  WithdrawRequest,
} from '../types.ts';
import {
  COUNCIL_MERGED,
  DEMO_LEADERBOARD,
  DEMO_MANIFEST,
  DEMO_MODELS,
  DEMO_PRICES,
  DEMO_RECEIPT_ROOTS,
  DEMO_ROUTES,
  DEMO_SIGNER,
  demoProposers,
  demoReply,
} from './fixtures.ts';

type KeyState = {
  caps: CreateKeyResponse['caps'];
  createdAt: string;
  addresses: DepositAddress[];
  available: number;
  held: number;
  refunded: number;
  sources: DepositSource[];
  ledger: Balance['recent'];
  characters: string[];
};

type State = { keys: Record<string, KeyState>; receipts: Record<string, SignedReceipt & { hourLeaves: string[] }> };

export type MockOptions = {
  /** Where state survives a page reload. `null` keeps it in memory only. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Delay between streamed chunks, in ms. */
  delayMs?: number;
  /** When false, anonymo-sealed answers 409 sealed_unavailable (no attested route is up). */
  sealedAvailable?: boolean;
};

const STORAGE_KEY = 'anonymo.demo.state.v1';
const enc = new TextEncoder();

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const randomB58 = (n: number) => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join('');
};
const randomKeyBody = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(b % 62),
  ).join('');

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function addressFor(chain: DepositChain): string {
  switch (chain) {
    case 'solana':
      return randomB58(44);
    case 'tron':
      return `T${randomB58(33)}`;
    case 'btc':
      return `bc1q${randomHex(19).slice(0, 38)}`;
    case 'ln':
      return '';
    default:
      return `0x${randomHex(20)}`;
  }
}

const TOKENS: Record<DepositChain, DepositToken[]> = {
  base: ['USDC', 'USDT', 'USDG'],
  arbitrum: ['USDC', 'USDT', 'USDG'],
  rhc: ['USDC', 'USDT', 'USDG'],
  solana: ['USDC', 'USDT'],
  tron: ['USDT'],
  btc: ['BTC'],
  ln: ['BTC'],
};
const CONFIRMATIONS: Record<DepositChain, number> = { base: 3, arbitrum: 3, rhc: 3, solana: 32, tron: 20, btc: 2, ln: 0 };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const fail = (status: number, code: string, message: string, category?: string) =>
  json({ error: { message, type: 'invalid_request_error', code, ...(category ? { metadata: { category } } : {}) } }, status);

const tokensOf = (text: string) => Math.max(1, Math.ceil(text.length / 4));

export function createMockGateway(options: MockOptions = {}) {
  const storage = options.storage === undefined ? null : options.storage;
  const delayMs = options.delayMs ?? 18;
  let state: State = { keys: {}, receipts: {} };
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (saved) state = JSON.parse(saved) as State;
  } catch {
    state = { keys: {}, receipts: {} };
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
    if (!key) return fail(401, 'invalid_api_key', 'Missing or malformed API key.');
    const found = state.keys[await sha256Hex(key)];
    return found ?? fail(401, 'invalid_api_key', 'Unknown API key.');
  }

  function record(k: KeyState, kind: LedgerKind, amount: number, ref: string | null) {
    k.ledger.unshift({ kind, amount_musd: amount, ref, at: new Date().toISOString() });
    k.ledger = k.ledger.slice(0, 50);
  }

  /** Demo-only: credit a deposit as if a watcher had confirmed it (stands in for DepositSink.credit). */
  async function simulateDeposit(key: string, chain: DepositChain, token: DepositToken, amountMusd: number) {
    const k = state.keys[await sha256Hex(key)];
    if (!k) throw new Error('Unknown key.');
    if (!Number.isSafeInteger(amountMusd) || amountMusd <= 0) throw new Error('Amount must be positive.');
    const from = chain === 'ln' ? 'lightning:demo-payer' : addressFor(chain === 'btc' ? 'btc' : chain);
    const existing = k.sources.find((s) => s.chain === chain && s.token === token);
    const source = existing ?? { chain, token, address: from, deposited_musd: 0, withdrawable_musd: 0 };
    if (!existing) k.sources.push(source);
    source.deposited_musd += amountMusd;
    source.withdrawable_musd += amountMusd;
    k.available += amountMusd;
    record(k, 'deposit', amountMusd, `${chain}:0x${randomHex(32)}`);
    persist();
  }

  async function createKey(request: Request) {
    const body = ((await request.json().catch(() => ({}))) ?? {}) as CreateKeyRequest;
    const key = `anm_live_${randomKeyBody()}`;
    const addresses: DepositAddress[] = (Object.keys(TOKENS) as DepositChain[]).map((chain) => ({
      chain,
      tokens: TOKENS[chain],
      address: addressFor(chain),
      confirmations: CONFIRMATIONS[chain],
      min_musd: chain === 'ln' ? 1_000_000 : 5_000_000,
    }));
    const createdAt = new Date().toISOString();
    state.keys[await sha256Hex(key)] = {
      caps: body.caps ?? {},
      createdAt,
      addresses,
      available: 0,
      held: 0,
      refunded: 0,
      sources: [],
      ledger: [],
      characters: [],
    };
    persist();
    const response: CreateKeyResponse = {
      key,
      key_prefix: key.slice(0, 13),
      caps: body.caps ?? {},
      created_at: createdAt,
      deposit_addresses: addresses,
    };
    return json(response, 201);
  }

  /** What each source can take back: its deposits less withdrawals, capped so the total never exceeds available. */
  function withdrawable(k: KeyState): DepositSource[] {
    let left = k.available;
    return k.sources.map((s) => {
      const amount = Math.max(0, Math.min(s.withdrawable_musd, left));
      left -= amount;
      return { ...s, withdrawable_musd: amount };
    });
  }

  function balanceOf(k: KeyState): Balance {
    return {
      available_musd: k.available,
      held_musd: k.held,
      refused_refunded_musd: k.refunded,
      sources: withdrawable(k),
      recent: k.ledger,
    };
  }

  async function withdraw(request: Request, k: KeyState) {
    const body = (await request.json().catch(() => null)) as WithdrawRequest | null;
    if (!body) return fail(400, 'invalid_request', 'Send chain, source_address and amount_musd.');
    if ('to' in (body as object) || 'address' in (body as object))
      return fail(400, 'destination_not_allowed', 'Withdrawals go only to the source address. Do not send a destination.');
    const source = k.sources.find((s) => s.chain === body.chain && s.address === body.source_address);
    if (!source) return fail(404, 'unknown_source', 'No deposit came from that address on that chain.');
    const cap = withdrawable(k).find((s) => s.chain === source.chain && s.address === source.address)?.withdrawable_musd ?? 0;
    const amount = body.amount_musd === 'all' ? cap : body.amount_musd;
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail(400, 'invalid_amount', 'Nothing to withdraw.');
    if (amount > cap)
      return fail(400, 'insufficient_balance', 'That is more than this source can take back.');
    source.withdrawable_musd -= amount;
    k.available -= amount;
    const id = `wd_${randomHex(8)}`;
    record(k, 'withdraw', -amount, id);
    persist();
    const result: Withdrawal = {
      id,
      chain: source.chain,
      token: source.token,
      to: source.address,
      amount_musd: amount,
      status: 'sent',
      tx_hash: source.chain === 'ln' ? null : `0x${randomHex(32)}`,
    };
    return json(result, 201);
  }

  async function chat(request: Request, k: KeyState) {
    const body = (await request.json().catch(() => null)) as ChatRequest | null;
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0)
      return fail(400, 'invalid_request', 'Send model and messages.');
    const model = body.model;
    const price = DEMO_PRICES[model];
    if (!price && !DEMO_MODELS.some((m) => m.id === model)) return fail(404, 'model_not_found', `Model ${model.slice(0, 80)} is not available.`);
    if (model === 'anonymo-sealed' && options.sealedAvailable === false)
      return fail(409, 'sealed_unavailable', 'No attested route is available for anonymo-sealed.');
    if (k.caps.sealed_only && model !== 'anonymo-sealed')
      return fail(403, 'sealed_only', 'This key may only use anonymo-sealed.');
    const promptText = body.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const tin = tokensOf(promptText);
    const p = price ?? DEMO_PRICES['anonymo-1'];
    const maxCost = Math.ceil((tin * p.in + 900 * p.out) / 1_000_000);
    if (k.available < maxCost) return fail(402, 'insufficient_balance', 'Not enough credit for this request.');

    // Hold at the maximum cost, settle to the actual cost when the stream ends (§7).
    k.available -= maxCost;
    k.held += maxCost;
    const requestId = crypto.randomUUID();

    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const rerouted = model === 'anonymo-1' && /\breroute\b/i.test(lastUser);
    const servers = DEMO_ROUTES.filter((r) => r.serves.includes(model) || r.model === model);
    let routes: string[];
    let council: CouncilResult | null = null;
    let text: string;
    if (model === 'anonymo-council') {
      const proposers = demoProposers();
      const picks = [DEMO_ROUTES[0], DEMO_ROUTES[3], DEMO_ROUTES[6]];
      council = {
        mode: request.headers.get('x-anonymo-council-mode') === 'select' ? 'select' : 'merge',
        aggregator: { route_id: DEMO_ROUTES[1].id, family: DEMO_ROUTES[1].family, cost_musd: 0 },
        proposers: picks.map((r, i) => ({
          route_id: r.id,
          family: r.family,
          content: proposers[i],
          cost_musd: Math.ceil((tin * 450_000 + tokensOf(proposers[i]) * 1_800_000) / 1_000_000),
          used: true,
        })),
      };
      if (council.mode === 'select') council.aggregator = null;
      text = council.mode === 'select' ? proposers[0] : COUNCIL_MERGED;
      routes = [...picks.map((r) => r.id), ...(council.aggregator ? [council.aggregator.route_id] : [])];
    } else {
      text = demoReply(model);
      const first = servers[0] ?? DEMO_ROUTES[0];
      const other = servers.find((r) => r.family !== first.family) ?? DEMO_ROUTES[2];
      routes = rerouted ? [first.id, other.id] : [first.id];
      if (rerouted)
        text = `The first route refused this, so the router retried on a different model family (${other.family}) and refunded the refused attempt. ${text}`;
    }
    const tout = tokensOf(text);
    const cost = Math.ceil((tin * p.in + tout * p.out) / 1_000_000);
    if (council?.aggregator) council.aggregator.cost_musd = Math.max(0, cost - council.proposers.reduce((s, x) => s + x.cost_musd, 0));
    const refusedCost = rerouted ? Math.ceil((tin * p.in + 40 * p.out) / 1_000_000) : 0;

    const route0 = DEMO_ROUTES.find((r) => r.id === routes[0]);
    const receipt: Receipt = {
      request_id: requestId,
      model_id: model,
      routes,
      weights_hash: routes.map((id) => DEMO_ROUTES.find((r) => r.id === id)?.weights_hash ?? null),
      attestation_quote_hash: model === 'anonymo-sealed' || route0?.attested ? keccakHex(enc.encode(`demo-quote:${requestId}`)) : null,
      tokens: { in: tin, out: tout },
      cost_musd: cost,
      refused: rerouted,
      refused_routes: rerouted ? [routes[0]] : [],
      refund_musd: refusedCost,
      ts: new Date().toISOString(),
    };
    const leaf = keccakHex(enc.encode(JSON.stringify(receipt)));
    // Other receipts in the same hour, so the inclusion path is a real multi-level path.
    const hourLeaves = Array.from({ length: 6 }, () => `0x${randomHex(32)}`);
    hourLeaves.splice(Math.floor(Math.random() * 7), 0, leaf);
    state.receipts[requestId] = { receipt, signer: DEMO_SIGNER, signature: `0x${randomHex(65)}`, leaf, hourLeaves };

    const chunks = text.match(/\S+\s*/g) ?? [text];
    const id = `chatcmpl-${randomHex(8)}`;
    const signal = request.signal;
    const settle = (delivered: number) => {
      const actual = Math.min(maxCost, delivered);
      k.held -= maxCost;
      k.available += maxCost - actual;
      if (refusedCost) {
        // The refused attempt is settled and refunded in full, so it nets to zero (§5).
        record(k, 'settle', -refusedCost, `${requestId}:refused`);
        record(k, 'refusal_refund', refusedCost, `${requestId}:refused`);
        k.refunded += refusedCost;
      }
      record(k, 'settle', -actual, requestId);
      persist();
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (chunk: ChatChunk) => controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        let sent = '';
        try {
          send({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          for (const piece of chunks) {
            if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
            await new Promise((r) => setTimeout(r, delayMs));
            sent += piece;
            send({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
          }
          send({
            id,
            object: 'chat.completion.chunk',
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            ...(council ? { anonymo_council: council } : {}),
          });
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          settle(cost);
          controller.close();
        } catch {
          // Charged only for the tokens delivered (§4).
          settle(Math.ceil((tin * p.in + tokensOf(sent) * p.out) / 1_000_000));
          try {
            controller.close();
          } catch {
            // already closed by the reader
          }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-anonymo-receipt': requestId,
        ...(council ? { 'x-anonymo-council-mode': council.mode } : {}),
      },
    });
  }

  function proofOf(id: string): InclusionProof | null {
    const r = state.receipts[id];
    if (!r) return null;
    // Same construction as gateway/src/receipts/merkle.ts: sorted-pair keccak, odd node promoted.
    let layer = r.hourLeaves;
    let index = layer.indexOf(r.leaf);
    const proof: string[] = [];
    while (layer.length > 1) {
      const sibling = index ^ 1;
      if (sibling < layer.length) proof.push(layer[sibling]);
      const next: string[] = [];
      for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i]);
      layer = next;
      index = Math.floor(index / 2);
    }
    return {
      request_id: id,
      leaf: r.leaf,
      proof,
      root: layer[0],
      hour: Math.floor(Date.parse(r.receipt.ts) / 3_600_000),
      anchor: { chain: 'rhc', contract: DEMO_RECEIPT_ROOTS, tx_hash: `0x${randomHex(32)}`, status: 'anchored' },
    };
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'GET' && path === API_PATHS.models) return json({ object: 'list', data: DEMO_MODELS });
    if (method === 'GET' && path === API_PATHS.manifest) return json(DEMO_MANIFEST);
    if (method === 'GET' && path === API_PATHS.leaderboard) return json(DEMO_LEADERBOARD);
    const receiptMatch = /^\/v1\/receipts\/([^/]+)(\/proof)?$/.exec(path);
    if (method === 'GET' && receiptMatch) {
      const id = decodeURIComponent(receiptMatch[1]);
      if (receiptMatch[2]) {
        const proof = proofOf(id);
        return proof ? json(proof) : fail(404, 'receipt_not_found', 'No receipt with that id.');
      }
      const r = state.receipts[id];
      if (!r) return fail(404, 'receipt_not_found', 'No receipt with that id.');
      const { hourLeaves: _hourLeaves, ...signed } = r;
      return json(signed);
    }
    if (method === 'POST' && path === API_PATHS.keys) return createKey(request);

    const k = await keyState(request);
    if (k instanceof Response) return k;
    if (method === 'GET' && path === API_PATHS.balance) return json(balanceOf(k));
    if (method === 'GET' && path === API_PATHS.depositAddresses) return json({ data: k.addresses });
    if (method === 'POST' && path === API_PATHS.lightningInvoice) {
      const body = (await request.json().catch(() => null)) as { amount_musd?: number } | null;
      const amount = body?.amount_musd;
      if (!Number.isSafeInteger(amount) || !amount || amount < 1_000_000) return fail(400, 'invalid_amount', 'Invoices start at $1.');
      const invoice: LightningInvoice = {
        invoice_id: `inv_${randomHex(8)}`,
        bolt11: `lnbc${Math.round(amount / 100)}n1p${randomHex(60)}`,
        amount_sats: Math.round(amount / 1_000_000 / 0.00095),
        quote_musd: amount,
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
      return json(invoice, 201);
    }
    if (method === 'POST' && path === API_PATHS.withdraw) return withdraw(request, k);
    if (method === 'POST' && path === API_PATHS.chat) return chat(request, k);
    if (method === 'POST' && path === API_PATHS.characters) {
      const body = (await request.json().catch(() => null)) as { sealed_card?: string; card_hash?: string; card?: unknown; png?: unknown } | null;
      if (body?.card || body?.png) return fail(400, 'plaintext_refused', 'A private card is sealed on your device; send sealed_card and card_hash.');
      if (!body?.sealed_card || !body.card_hash) return fail(400, 'invalid_request', 'Send sealed_card and card_hash.');
      const id = `ch_${randomHex(8)}`;
      k.characters.push(id);
      persist();
      return json({ data: { id, visibility: 'private', card_hash: body.card_hash } }, 201);
    }
    return fail(404, 'not_found', `No route for ${method} ${path}.`);
  }

  const mockFetch = (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init));

  return { fetch: mockFetch as typeof fetch, simulateDeposit };
}

export type MockGateway = ReturnType<typeof createMockGateway>;
