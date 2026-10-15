import bs58 from 'bs58';
import {
  address,
  signature,
  record,
  list,
  uint,
  amount,
  requireSolana,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
} from '../solana/validation.ts';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export type TradeDelta = {
  mint: string;
  decimals: number;
  amount: string;
  kind: 'swap' | 'transfer' | 'airdrop' | 'unknown';
  counterparty: string | null;
};
export type TradeFee = {
  kind:
    | 'network'
    | 'priority'
    | 'network_and_priority'
    | 'jito_tip'
    | 'platform';
  mint: string;
  decimals: number;
  amount: string;
};
export type WalletTrade = {
  signature: string;
  transactionIndex: number | null;
  slot: string;
  timestamp: string | null;
  wallet: string;
  feePayer: string;
  signer: boolean;
  failed: boolean;
  deltas: TradeDelta[];
  fees: TradeFee[];
  rentLamports: string;
  warnings: string[];
};
export type TradeParserOptions = {
  transactionIndex?: number;
  airdropSignatures?: readonly string[];
  feePolicyReviewed?: boolean;
  jitoAccounts?: readonly string[];
  platformAccounts?: readonly string[];
};
const n = (v: unknown) => BigInt(uint(v));
function key(value: unknown) {
  return typeof value === 'string'
    ? address(value)
    : address(record(value).pubkey);
}

/** Parse exact balance deltas, never provider prose/logs or uiAmount floats. */
export function parseWalletTrade(
  value: unknown,
  wallet: string,
  expectedSignature: string,
  options: TradeParserOptions = {},
): WalletTrade {
  address(wallet);
  signature(expectedSignature);
  const raw = record(value),
    tx = record(raw.transaction),
    msg = record(tx.message),
    meta = record(raw.meta);
  requireSolana(
    raw.version === 'legacy' || raw.version === 0 || raw.version === undefined,
    'unsupported_transaction',
  );
  const signatures = list(tx.signatures, 64).map(signature);
  requireSolana(signatures[0] === expectedSignature, 'invalid_response');
  const keys = list(msg.accountKeys, 256).map(key);
  requireSolana(
    keys.length > 0 && new Set(keys).size === keys.length,
    'invalid_response',
  );
  const walletIndex = keys.indexOf(wallet);
  const pre = list(meta.preBalances, 256).map(n),
    post = list(meta.postBalances, 256).map(n);
  requireSolana(
    pre.length === keys.length && post.length === keys.length,
    'invalid_response',
  );
  const slot = uint(raw.slot),
    timestamp =
      raw.blockTime === null
        ? null
        : new Date(uint(raw.blockTime, 8_640_000_000_000) * 1000).toISOString();
  requireSolana(
    Object.hasOwn(meta, 'err') &&
      (meta.err === null ||
        typeof meta.err === 'string' ||
        (typeof meta.err === 'object' && !Array.isArray(meta.err))),
    'invalid_response',
  );
  const walletKey = list(msg.accountKeys)[walletIndex];
  const signer =
    walletIndex < 0
      ? false
      : typeof walletKey === 'object' && walletKey !== null
        ? record(walletKey).signer === true
        : walletIndex < uint(record(msg.header).numRequiredSignatures, 64);
  const warnings = new Set<string>();
  const fee = n(meta.fee),
    paid = keys[0] === wallet;
  const fees: TradeFee[] = [];
  const parsedInstructions = [
    ...list(msg.instructions, 256),
    ...list(meta.innerInstructions ?? [], 256).flatMap((v) =>
      list(record(v).instructions, 512),
    ),
  ];
  const instructions = parsedInstructions.map(record);
  let priority: bigint | null = null,
    computeLimit: bigint | null = null,
    computePrice: bigint | null = null;
  let computeUnknown = false;
  for (const ix of list(msg.instructions, 256).map(record)) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM) continue;
    if (typeof ix.data !== 'string') {
      computeUnknown = true;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(ix.data);
    } catch {
      throw new Error('Invalid compute budget metadata.');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      !(
        (bytes[0] === 2 && bytes.length === 5) ||
        (bytes[0] === 3 && bytes.length === 9) ||
        (bytes[0] === 1 && bytes.length === 5) ||
        (bytes[0] === 4 && bytes.length === 5)
      )
    )
      computeUnknown = true;
    if (bytes[0] === 2 && bytes.length === 5) {
      requireSolana(computeLimit === null, 'invalid_response');
      computeLimit = BigInt(view.getUint32(1, true));
    }
    if (bytes[0] === 3 && bytes.length === 9) {
      requireSolana(computePrice === null, 'invalid_response');
      computePrice = view.getBigUint64(1, true);
    }
  }
  if (!computeUnknown && (computePrice === null || computePrice === 0n))
    priority = 0n;
  else if (!computeUnknown && computeLimit !== null && computePrice !== null)
    priority = (computeLimit * computePrice + 999_999n) / 1_000_000n;
  if (paid) {
    if (priority !== null && priority <= fee) {
      fees.push(
        {
          kind: 'network',
          mint: SOL_MINT,
          decimals: 9,
          amount: (fee - priority).toString(),
        },
        {
          kind: 'priority',
          mint: SOL_MINT,
          decimals: 9,
          amount: priority.toString(),
        },
      );
    } else {
      fees.push({
        kind: 'network_and_priority',
        mint: SOL_MINT,
        decimals: 9,
        amount: fee.toString(),
      });
      warnings.add('FEE_SPLIT_UNAVAILABLE');
    }
  }
  const result: WalletTrade = {
    signature: expectedSignature,
    transactionIndex:
      options.transactionIndex === undefined
        ? null
        : uint(options.transactionIndex, 1000000),
    slot: String(slot),
    timestamp,
    wallet,
    feePayer: keys[0],
    signer,
    failed: meta.err !== null,
    deltas: [],
    fees,
    rentLamports: '0',
    warnings: [],
  };
  if (result.failed) {
    result.warnings = timestamp === null ? ['BLOCK_TIME_UNAVAILABLE'] : [];
    return result;
  }
  requireSolana(
    Array.isArray(meta.preTokenBalances) &&
      Array.isArray(meta.postTokenBalances),
    'incomplete_metadata',
  );
  const tokenAccounts = new Map<
    string,
    {
      mint: string;
      decimals: number;
      owner: string;
      pre: bigint;
      post: bigint;
      index: number;
    }
  >();
  for (const phase of ['pre', 'post'] as const) {
    const seen = new Set<number>();
    for (const item of list(
      meta[phase === 'pre' ? 'preTokenBalances' : 'postTokenBalances'],
      256,
    )) {
      const b = record(item),
        index = uint(b.accountIndex, keys.length - 1),
        mint = address(b.mint),
        owner = address(b.owner),
        ui = record(b.uiTokenAmount),
        decimals = uint(ui.decimals, 18);
      requireSolana(
        !seen.has(index) &&
          (b.programId === TOKEN_PROGRAM || b.programId === TOKEN_2022_PROGRAM),
        'invalid_response',
      );
      seen.add(index);
      const old = tokenAccounts.get(keys[index]);
      requireSolana(
        !old ||
          (old.mint === mint &&
            old.owner === owner &&
            old.decimals === decimals),
        'incomplete_metadata',
      );
      const entry = old ?? { mint, owner, decimals, pre: 0n, post: 0n, index };
      entry[phase] = amount(ui.amount);
      tokenAccounts.set(keys[index], entry);
      if (b.programId === TOKEN_2022_PROGRAM && owner === wallet)
        warnings.add('TOKEN_2022_EXTENSIONS_UNACCOUNTED');
    }
  }
  requireSolana(
    walletIndex >= 0 ||
      [...tokenAccounts.values()].some((t) => t.owner === wallet),
    'invalid_response',
  );
  const deltas = new Map<string, { amount: bigint; decimals: number }>();
  const add = (mint: string, decimals: number, delta: bigint) => {
    const old = deltas.get(mint);
    requireSolana(!old || old.decimals === decimals, 'invalid_response');
    deltas.set(mint, { decimals, amount: (old?.amount ?? 0n) + delta });
  };
  for (const token of tokenAccounts.values())
    if (token.owner === wallet)
      add(token.mint, token.decimals, token.post - token.pre);
  let rent = 0n;
  // Only recognized System account creation funded by this wallet and SPL closures to it.
  for (const ix of instructions) {
    if (!ix.parsed || typeof ix.parsed !== 'object') continue;
    const parsed = record(ix.parsed),
      info = record(parsed.info);
    if (
      ix.programId === SYSTEM_PROGRAM &&
      (parsed.type === 'createAccount' ||
        parsed.type === 'createAccountWithSeed') &&
      info.source === wallet
    ) {
      const created = tokenAccounts.get(address(info.newAccount));
      if (created?.owner === wallet) {
        const principal = created.mint === SOL_MINT ? created.post : 0n;
        const funded = n(info.lamports);
        if (funded >= principal) rent += funded - principal;
        else warnings.add('RENT_UNRESOLVED');
      } else warnings.add('RENT_UNRESOLVED');
    }
    if (
      (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) &&
      parsed.type === 'closeAccount' &&
      info.destination === wallet
    ) {
      const accountIndex = keys.indexOf(address(info.account));
      requireSolana(accountIndex >= 0, 'invalid_response');
      const token = tokenAccounts.get(keys[accountIndex]);
      // Wrapped SOL principal is not rent. An unknown account's refund cannot be split reliably.
      if (
        token?.owner === wallet &&
        pre[accountIndex] >= (token.mint === SOL_MINT ? token.pre : 0n)
      )
        rent -= pre[accountIndex] - (token.mint === SOL_MINT ? token.pre : 0n);
      else warnings.add('RENT_UNRESOLVED');
    }
  }
  result.rentLamports = rent.toString();
  add(
    SOL_MINT,
    9,
    (walletIndex >= 0 ? post[walletIndex] - pre[walletIndex] : 0n) +
      (paid ? fee : 0n) +
      rent,
  );
  const feeDestinations = new Map<string, TradeFee['kind']>();
  for (const destination of options.jitoAccounts ?? [])
    feeDestinations.set(address(destination), 'jito_tip');
  for (const destination of options.platformAccounts ?? []) {
    address(destination);
    requireSolana(!feeDestinations.has(destination), 'invalid_configuration');
    feeDestinations.set(destination, 'platform');
  }
  const transfers: {
    mint: string;
    amount: bigint;
    from: string;
    to: string;
  }[] = [];
  const minted = new Set<string>();
  for (const ix of instructions) {
    if (!ix.parsed || typeof ix.parsed !== 'object') continue;
    const parsed = record(ix.parsed),
      info = record(parsed.info);
    if (
      ix.programId === SYSTEM_PROGRAM &&
      (parsed.type === 'transfer' || parsed.type === 'transferWithSeed')
    ) {
      const from = address(info.source),
        to = address(info.destination),
        value = n(info.lamports);
      transfers.push({ mint: SOL_MINT, amount: value, from, to });
      const kind = feeDestinations.get(to);
      if (from === wallet && kind) {
        fees.push({
          kind,
          mint: SOL_MINT,
          decimals: 9,
          amount: value.toString(),
        });
        add(SOL_MINT, 9, value);
      }
    }
    if (ix.programId !== TOKEN_PROGRAM && ix.programId !== TOKEN_2022_PROGRAM)
      continue;
    if (parsed.type === 'mintTo' || parsed.type === 'mintToChecked') {
      const destination = tokenAccounts.get(address(info.account));
      if (destination?.owner === wallet) minted.add(destination.mint);
    }
    if (parsed.type === 'transfer' || parsed.type === 'transferChecked') {
      const source = tokenAccounts.get(address(info.source)),
        destination = tokenAccounts.get(address(info.destination));
      const value =
        parsed.type === 'transferChecked'
          ? amount(record(info.tokenAmount).amount)
          : amount(info.amount);
      if (source && destination) {
        requireSolana(
          source.mint === destination.mint &&
            source.decimals === destination.decimals,
          'invalid_response',
        );
        transfers.push({
          mint: source.mint,
          amount: value,
          from: source.owner,
          to: destination.owner,
        });
      }
      const kind =
        typeof info.destination === 'string'
          ? feeDestinations.get(info.destination)
          : undefined;
      if (source?.owner === wallet && kind) {
        fees.push({
          kind,
          mint: source.mint,
          decimals: source.decimals,
          amount: value.toString(),
        });
        add(source.mint, source.decimals, value);
      }
    }
  }
  const nonzero = [...deltas].filter(([, d]) => d.amount !== 0n);
  // A two-sided delta is a fallback, not proof of a router/price or complete economic intent.
  const positive = nonzero.filter(([, d]) => d.amount > 0n),
    negative = nonzero.filter(([, d]) => d.amount < 0n);
  const swap = signer && positive.length === 1 && negative.length === 1;
  if (swap) warnings.add('BALANCE_DELTA_SWAP_INFERRED');
  if (nonzero.length > 2 && positive.length && negative.length)
    warnings.add('COMPLEX_TRANSACTION_UNCLASSIFIED');
  if (!options.feePolicyReviewed)
    warnings.add('PLATFORM_FEE_COVERAGE_UNAVAILABLE');
  if (!options.feePolicyReviewed) warnings.add('JITO_TIP_COVERAGE_UNAVAILABLE');
  if (timestamp === null) warnings.add('BLOCK_TIME_UNAVAILABLE');
  for (const [mint, d] of nonzero) {
    const matching = transfers.filter(
      (t) =>
        t.mint === mint &&
        (d.amount > 0n ? t.to === wallet : t.from === wallet),
    );
    const counterparties = new Set(
      matching.map((t) => (d.amount > 0n ? t.from : t.to)),
    );
    const transferred = matching.reduce((sum, t) => sum + t.amount, 0n);
    const exactTransfer =
      counterparties.size === 1 &&
      transferred === (d.amount < 0n ? -d.amount : d.amount);
    const kind = swap
      ? 'swap'
      : minted.has(mint) &&
          options.airdropSignatures?.includes(expectedSignature) &&
          d.amount > 0n &&
          !negative.length
        ? 'airdrop'
        : exactTransfer
          ? 'transfer'
          : 'unknown';
    if (kind === 'airdrop') warnings.add('MINT_DISTRIBUTION_ZERO_BASIS');
    if (kind === 'unknown') warnings.add('UNCLASSIFIED_BALANCE_CHANGE');
    result.deltas.push({
      mint,
      decimals: d.decimals,
      amount: d.amount.toString(),
      kind,
      counterparty: exactTransfer ? [...counterparties][0] : null,
    });
  }
  result.warnings = [...warnings].sort();
  return result;
}
