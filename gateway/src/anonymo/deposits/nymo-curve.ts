// Pons V2 native-ETH launch curve. Payments burn NYMO. The reference value is the native ETH a sale of the same
// number of tokens could have returned at the confirmed block, converted at that block's verified ETH/USD price.
import { parseAbi, zeroAddress, type PublicClient } from "viem";

const NYMO_CONTRACT_ADDRESS = "0xafe293638b064d7786c5326a071520358c3f3198";

export const NYMO_CURVE_MARKET = {
  token: NYMO_CONTRACT_ADDRESS,
  curve: "0x82e07decaf39c2e76d03857ccc7a9ea37f6da2be",
  factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
} as const;

const ABI = parseAbi([
  "function curve() view returns (address)",
  "function token() view returns (address)",
  "function factory() view returns (address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function isNativeQuote() view returns (bool)",
  "function pairToken() view returns (address)",
  "function readyToGraduate() view returns (bool)",
  "function graduated() view returns (bool)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function realQuoteReserve() view returns (uint256)",
  "function phantomQuote() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const UNIT = 10n ** 18n;
const ONE_USD_PICO = 10n ** 12n;
const MAX_PAYMENT_PICO = 250n * ONE_USD_PICO;
const DEPTH_MULTIPLE = 10n;
const BPS = 10_000n;
const UINT256_MAX = (1n << 256n) - 1n;
const TRADE_FEE_BPS = 100n;
const CREATOR_TAX_BPS = 150n;

/** Decimal strings allow exact storage in the watcher's JSON history. */
export type NymoCurveSnapshot = {
  quoteReserve: string;
  tokenReserve: string;
  realQuoteReserve: string;
  ethUsdPico: string;
  feeBps: number;
  creatorTaxBps: number;
};

/** The caller verifies the chain and Chainlink round at this same confirmed block. */
export async function readNymoCurveSnapshot(client: Pick<PublicClient, "readContract" | "getBalance">, blockNumber: bigint, ethUsdPico: bigint): Promise<NymoCurveSnapshot | null> {
  if (ethUsdPico <= 0n || ethUsdPico > UINT256_MAX) return null;
  const { token, curve, factory } = NYMO_CURVE_MARKET;
  const base = { abi: ABI, blockNumber };
  try {
    const [boundCurve, symbol, decimals, boundToken, boundFactory, nativeQuote, pairToken, graduated, ready, reserves, real, phantom, fee, tax, ethBalance, tokenBalance] = await Promise.all([
      client.readContract({ ...base, address: token, functionName: "curve" }),
      client.readContract({ ...base, address: token, functionName: "symbol" }),
      client.readContract({ ...base, address: token, functionName: "decimals" }),
      client.readContract({ ...base, address: curve, functionName: "token" }),
      client.readContract({ ...base, address: curve, functionName: "factory" }),
      client.readContract({ ...base, address: curve, functionName: "isNativeQuote" }),
      client.readContract({ ...base, address: curve, functionName: "pairToken" }),
      client.readContract({ ...base, address: curve, functionName: "graduated" }),
      client.readContract({ ...base, address: curve, functionName: "readyToGraduate" }),
      client.readContract({ ...base, address: curve, functionName: "getReserves" }),
      client.readContract({ ...base, address: curve, functionName: "realQuoteReserve" }),
      client.readContract({ ...base, address: curve, functionName: "phantomQuote" }),
      client.readContract({ ...base, address: curve, functionName: "feeBps" }),
      client.readContract({ ...base, address: curve, functionName: "creatorTaxBps" }),
      client.getBalance({ address: curve, blockNumber }),
      client.readContract({ ...base, address: token, functionName: "balanceOf", args: [curve] }),
    ]);
    if (boundCurve.toLowerCase() !== curve || boundToken.toLowerCase() !== token || boundFactory.toLowerCase() !== factory) return null;
    if (symbol !== "NYMO" || decimals !== 18 || !nativeQuote || pairToken !== zeroAddress || graduated || ready) return null;
    const [quoteReserve, tokenReserve] = reserves;
    if (fee !== TRADE_FEE_BPS || tax !== CREATOR_TAX_BPS || phantom <= 0n || real <= 0n || real > ethBalance) return null;
    if (quoteReserve !== real + phantom || tokenReserve <= 0n || tokenReserve > tokenBalance) return null;
    return { quoteReserve: quoteReserve.toString(), tokenReserve: tokenReserve.toString(), realQuoteReserve: real.toString(), ethUsdPico: ethUsdPico.toString(), feeBps: Number(fee), creatorTaxBps: Number(tax) };
  } catch {
    return null;
  }
}

const positiveUint = (s: unknown): s is string => typeof s === "string" && /^[1-9]\d{0,77}$/.test(s) && BigInt(s) <= UINT256_MAX;

export type NymoCurveQuote = { valuePico: bigint; depthBudgetPico: bigint; maxAmountRaw: bigint; withinLimit: boolean };

/**
 * Pons' integer sell formula: gross = in * quoteReserve / (tokenReserve + in); trade fee and creator tax are each
 * rounded down separately and subtracted from gross. See https://docs.ponsfamily.com/v2#quoting.
 * Above the automatic limit, valuePico describes only the maximum supported amount for operator review.
 */
export function nymoCurveQuote(sample: NymoCurveSnapshot, amountRaw: bigint, maxUsdPico: bigint): NymoCurveQuote | null {
  if (!sample || amountRaw <= 0n || amountRaw > UINT256_MAX || maxUsdPico <= 0n) return null;
  if (![sample.quoteReserve, sample.tokenReserve, sample.realQuoteReserve, sample.ethUsdPico].every(positiveUint)) return null;
  if (sample.feeBps !== Number(TRADE_FEE_BPS) || sample.creatorTaxBps !== Number(CREATOR_TAX_BPS)) return null;
  const real = BigInt(sample.realQuoteReserve);
  const reserve = BigInt(sample.quoteReserve);
  const tokens = BigInt(sample.tokenReserve);
  const ethUsd = BigInt(sample.ethUsdPico);
  if (real >= reserve) return null;
  const cap = maxUsdPico < MAX_PAYMENT_PICO ? maxUsdPico : MAX_PAYMENT_PICO;
  const depthBudgetPico = real * ethUsd / (UNIT * DEPTH_MULTIPLE);
  if (depthBudgetPico < cap) return null;
  // Both bounds apply to the gross ETH output before fees. Invert the constant-product formula rounding DOWN.
  const maxWeiByUsd = cap * UNIT / ethUsd;
  const maxWeiByDepth = real / DEPTH_MULTIPLE;
  const maxGross = maxWeiByUsd < maxWeiByDepth ? maxWeiByUsd : maxWeiByDepth;
  if (maxGross <= 0n) return null;
  const maxAmountRaw = maxGross * tokens / (reserve - maxGross);
  if (maxAmountRaw <= 0n) return null;
  const withinLimit = amountRaw <= maxAmountRaw;
  const priced = withinLimit ? amountRaw : maxAmountRaw;
  const gross = priced * reserve / (tokens + priced);
  if (gross > maxGross || gross > real) return null;
  // Both independently rounded fees can increase together at the next wei. The lower envelope of the two exact
  // sell quotes is monotone for target-USD inversion and gives up at most one wei of hypothetical sale proceeds.
  const afterFees = (wei: bigint) => wei - wei * TRADE_FEE_BPS / BPS - wei * CREATOR_TAX_BPS / BPS;
  const current = afterFees(gross);
  const next = afterFees(gross + 1n);
  const net = current < next ? current : next;
  return { valuePico: net * ethUsd / UNIT, depthBudgetPico, maxAmountRaw, withinLimit };
}
