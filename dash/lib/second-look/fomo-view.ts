import type { FomoAnalysis } from "./fomo";

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** Keep provider calculations, reported windows and lifetime counters separate. */
export function fomoProfileView(report: FomoAnalysis) {
  const source = report.sources.find(
    (s) => s.id.startsWith("public-profile-") && record(s.data?.trader),
  );
  const data = source?.data;
  const trader = record(data?.trader);
  if (!source || !data || !trader) return null;
  const sampled = data.coverage === "sampled-top-100";
  const conflictingSource =
    !sampled && typeof trader.source === "string" && trader.source !== data.source;
  return {
    source,
    sampled,
    handle: typeof trader.handle === "string" ? trader.handle : report.input.handle,
    displayName: typeof trader.displayName === "string" ? trader.displayName : null,
    avatarUrl: safeFomoImageUrl(trader.avatarUrl),
    window: typeof data.window === "string" ? data.window : "Unknown period",
    rank: conflictingSource ? null : finite(sampled ? trader.position : trader.rank),
    reportedPnl: conflictingSource ? null : finite(sampled ? trader.pnl : trader.pnlUsd),
    sourceLabel: sampled
      ? "Independent sample"
      : data.source === "fomo"
        ? "FOMO-reported"
        : data.source === "computed"
          ? "Provider-computed"
          : "Source-reported",
    basis:
      (trader.pnlBasis ?? data.pnlBasis) === "mark-to-market"
        ? "Includes open positions"
        : "Source-reported PnL",
    stale: data.stale === true,
    lowPriceCoverage: !sampled && trader.lowCoverage === true,
    totalsObservedAt:
      typeof (sampled ? trader.profileObservedAt : trader.fomoProfileSyncedAt) === "string"
        ? String(sampled ? trader.profileObservedAt : trader.fomoProfileSyncedAt)
        : null,
    followers: finite(trader.followers),
    realized30d: sampled ? null : finite(trader.realizedPnlUsd),
    unrealized30d: sampled ? null : finite(trader.unrealizedPnlUsd),
    net30d: sampled ? null : finite(trader.computedPnlUsd),
    volume30d: sampled ? null : finite(trader.volumeUsd),
    trades30d: sampled ? null : finite(trader.trades),
    lifetimePnl: sampled ? null : finite(trader.allTimePnlUsd),
    lifetimeTrades: finite(sampled ? trader.numTrades : trader.fomoNumTrades),
    walletsKnown: Array.isArray(trader.wallets) && trader.wallets.length > 0,
    holdings: Array.isArray(trader.topHoldings)
      ? trader.topHoldings.map(record).filter((h): h is Record<string, unknown> => h !== null)
      : [],
  };
}
export function fomoCallsView(report: FomoAnalysis) {
  const source =
    report.sources.find(
      (s) => s.id === "calls" && s.state !== "unavailable" && Array.isArray(s.data?.items),
    ) ?? report.sources.find((s) => s.id === "public-trader-calls" && s.state !== "unavailable") ?? report.sources.find((s) => s.id === "public-calls");
  const retrieved = Boolean(
    source && source.state !== "unavailable" && Array.isArray(source.data?.items),
  );
  const publicFeed = source?.id === "public-calls";
  const count = finite(source?.data?.feedCount);
  return {
    source,
    retrieved,
    items:
      retrieved && Array.isArray(source?.data?.items)
        ? source.data.items
            .map(record)
            .filter((item): item is Record<string, unknown> => item !== null)
        : [],
    scope: !retrieved
      ? "A callout feed was not retrieved for this research."
      : source?.id === "public-trader-calls"
        ? `The free trader page exposes ${Array.isArray(source.data?.items) ? source.data.items.length : 0} recent calls. This sample is not the complete account history.`
      : publicFeed
        ? count === null
          ? "The source supplied a recent public sample. The number of calls checked is not supplied."
          : `We checked the latest ${count} public calls. This is a recent sample, not the trader’s full history.`
        : "Up to 20 indexed callouts. This is a retrieved snapshot, not a complete timeline.",
  };
}
export type FomoProfileView = NonNullable<ReturnType<typeof fomoProfileView>>;
export function formatFomoMoney(value: unknown, compact = false, signed = false) {
  const n = finite(value);
  if (n === null) return "Not available";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: compact ? 2 : 0,
    notation: compact ? "compact" : "standard",
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(n);
}
export function formatFomoTime(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Time not supplied";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
    hour12: false,
  }).format(new Date(value));
}

/** Images are display-only; never fetch arbitrary source URLs on the server. */
export function safeFomoImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const allowed =
      (url.hostname === "prod-fomo-profile-pics.s3.amazonaws.com" &&
        /\.(jpg|jpeg|png|webp)$/i.test(url.pathname)) ||
      (url.hostname === "cdn.dexscreener.com" && url.pathname.startsWith("/cms/images/"));
    return allowed ? url.href : null;
  } catch {
    return null;
  }
}
