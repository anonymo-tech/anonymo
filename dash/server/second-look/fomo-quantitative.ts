import { FOMO_FACTORS, FOMO_METHOD_VERSION } from '../../lib/second-look/fomo-research.ts';

/** Internal adapter contract, NOT an HTTP input schema. No existing public feed
 * satisfies it. A future reconciliation adapter must construct this from source
 * receipts; never cast model output, a leaderboard or submitted JSON to this type. */
export type ReconciledHistory = {
  windowEnd: string;
  attribution: 'published-wallet-confirmed';
  complete: { ledger: boolean; fees: boolean; inventory: boolean; cashFlows: boolean; calloutCohort: boolean };
  receipts: { id: string; sha256: string; observedAt: string; method: 'finalized-chain' | 'archived-publication' | 'historical-quote' }[];
  days: {
    date: string;
    // Each segment ends immediately before an external flow, next starts after it.
    // Fees are already in NAV. The intervals partition this UTC day.
    segments: { start: string; end: string; openingNav: number; closingNav: number; benchmarkOpen: number; benchmarkClose: number; receiptIds: string[] }[];
    holdings: { asset: string; valueUsd: number }[];
    portfolioValueUsd: number;
    receiptIds: string[];
  }[];
  positions: { id: string; asset: string; openedAt: string; closedAt: string; netPnlUsd: number; costBasisUsd: number; receiptIds: string[] }[];
  executions: { id: string; at: string; notionalUsd: number; feesUsd: number; adverseSlippageBps: number; receiptIds: string[] }[];
  calls: { id: string; asset: string; publishedAt: string; evaluatedAt: string; entryAt: string; entryUsd: number; exitUsd: number; costsFraction: number; benchmarkEntry: number; benchmarkExit: number; receiptIds: string[] }[];
};
export type QuantitativeScore = {
  version: string; status: 'insufficient-evidence' | 'experimental';
  score: number | null; reasons: string[];
  factors: { id: string; label: string; weight: number; score: number | null; contribution: number | null; metric: string }[];
  diagnostics: Record<string, number>;
  calibration: 'not-validated-on-held-out-traders';
};
const DAY = 86400_000;
const number = (n: number) => Number.isFinite(n);
const clamp = (n: number) => Math.min(100, Math.max(0, n));
const median = (xs: number[]) => { const x = [...xs].sort((a,b) => a-b), n = x.length; return n % 2 ? x[(n-1)/2] : (x[n/2-1]+x[n/2])/2; };
const time = (s: string) => Date.parse(s);
const unique = (xs: string[]) => new Set(xs).size === xs.length;

/** Nominal Wilson interval for the descriptive closed-position win proportion.
 * Correlated positions violate independent Bernoulli assumptions; this diagnostic
 * is never presented as confidence in future returns or in the composite score. */
export function wilsonInterval(wins: number, n: number): [number, number] | null {
  if (!Number.isInteger(wins) || !Number.isInteger(n) || n <= 0 || wins < 0 || wins > n) return null;
  const z = 1.95996398454, z2 = z*z, p = wins/n, d = 1+z2/n;
  const center = (p+z2/(2*n))/d, spread = z*Math.sqrt(p*(1-p)/n+z2/(4*n*n))/d;
  return [Math.max(0,center-spread), Math.min(1,center+spread)];
}
export function scoreReconciledFomoHistory(h: ReconciledHistory | null): QuantitativeScore {
  const reasons: string[] = [];
  const result: QuantitativeScore = {
    version: FOMO_METHOD_VERSION, status: 'insufficient-evidence', score: null, reasons,
    factors: FOMO_FACTORS.map(f => ({ id:f.id, label:f.label, weight:f.weight, score:null, contribution:null, metric:f.requirement })),
    diagnostics:{}, calibration:'not-validated-on-held-out-traders',
  };
  if (!h) { reasons.push('No reconciled history. Public PnL summaries cannot enter this calculation.'); return result; }
  const end = time(h.windowEnd), start = end - 30*DAY;
  if (!number(end) || end % DAY !== 0) reasons.push('Window must end at a UTC day boundary.');
  if (h.attribution !== 'published-wallet-confirmed' || !Object.values(h.complete).every(v => v === true) ||
      !['ledger','fees','inventory','cashFlows','calloutCohort'].every(k => h.complete[k as keyof typeof h.complete] === true))
    reasons.push('Wallet attribution, complete ledger, inventory, cash flows, fees and callout cohort must be reconciled.');
  const receiptMap = new Map(h.receipts.map(r => [r.id,r]));
  if (!unique(h.receipts.map(r => r.id)) || h.receipts.some(r => !r.id || !/^[a-f0-9]{64}$/.test(r.sha256) || !number(time(r.observedAt)) || !['finalized-chain','archived-publication','historical-quote'].includes(r.method))) reasons.push('Invalid or duplicated evidence receipts.');
  const refs = (xs: string[], methods: ReconciledHistory['receipts'][number]['method'][]) => xs.length > 0 && unique(xs) && xs.every(x => receiptMap.has(x)) && methods.every(m => xs.some(x => receiptMap.get(x)?.method === m));
  const days = [...h.days].sort((a,b) => time(a.date)-time(b.date));
  if (days.length !== 30 || days.some((d,i) => time(d.date) !== start+i*DAY)) reasons.push('Exactly 30 consecutive complete UTC days are required.');
  const dailyReturns: number[] = [], benchmarkReturns: number[] = [], concentration: number[] = [];
  for (const d of days) {
    const t = time(d.date), segments = [...d.segments].sort((a,b) => time(a.start)-time(b.start));
    if (!segments.length || time(segments[0].start) !== t || time(segments.at(-1)!.end) !== t+DAY || segments.some((s,i) =>
      !number(time(s.start)) || !number(time(s.end)) || time(s.start) >= time(s.end) || (i>0 && time(s.start) !== time(segments[i-1].end)) ||
      ![s.openingNav,s.closingNav,s.benchmarkOpen,s.benchmarkClose].every(number) || s.openingNav <= 0 || s.closingNav < 0 || s.benchmarkOpen <= 0 || s.benchmarkClose <= 0 ||
      !refs(s.receiptIds,['finalized-chain','historical-quote']))) reasons.push('Incomplete valuation intervals, benchmark or interval receipts.');
    if (!number(d.portfolioValueUsd) || d.portfolioValueUsd <= 0 || !d.holdings.length || !unique(d.holdings.map(x=>x.asset)) || d.holdings.some(x=>!x.asset || !number(x.valueUsd) || x.valueUsd < 0) ||
      Math.abs(d.holdings.reduce((s,x)=>s+x.valueUsd,0)-d.portfolioValueUsd)>Math.max(.01,d.portfolioValueUsd*1e-6) || !refs(d.receiptIds,['finalized-chain','historical-quote'])) reasons.push('Holdings must reconcile to the complete portfolio value.');
    dailyReturns.push(segments.reduce((v,s)=>v*s.closingNav/s.openingNav,1)-1);
    benchmarkReturns.push(segments.reduce((v,s)=>v*s.benchmarkClose/s.benchmarkOpen,1)-1);
    concentration.push(d.holdings.reduce((v,x)=>v+(x.valueUsd/d.portfolioValueUsd)**2,0));
  }
  if (h.positions.length < 30 || new Set(h.positions.map(x=>x.asset)).size < 3 || !unique(h.positions.map(x=>x.id)) || h.positions.some(x=>
    !x.id || !x.asset || !number(x.netPnlUsd) || !number(x.costBasisUsd) || x.costBasisUsd <= 0 || x.netPnlUsd < -x.costBasisUsd ||
    !number(time(x.openedAt)) || time(x.openedAt)>time(x.closedAt) || !(time(x.closedAt)>=start && time(x.closedAt)<end) || !refs(x.receiptIds,['finalized-chain','historical-quote']))) reasons.push('Need 30 distinct reconciled closed positions across 3 assets within the window.');
  if (h.executions.length < 30 || !unique(h.executions.map(x=>x.id)) || h.executions.some(x=>
    !x.id || ![x.notionalUsd,x.feesUsd,x.adverseSlippageBps].every(number) || x.notionalUsd<=0 || x.feesUsd<0 || x.adverseSlippageBps<0 ||
    !(time(x.at)>=start && time(x.at)<end) || !refs(x.receiptIds,['finalized-chain','historical-quote']))) reasons.push('Need the complete execution sample with fees and arrival-price receipts.');
  // Fixed 24h outcome, executable entry 5 minutes after publication. No peak-price selection.
  if (h.calls.length<10 || new Set(h.calls.map(x=>x.asset)).size<3 || !unique(h.calls.map(x=>x.id)) || h.calls.some(x=>
    !x.id || !x.asset || ![x.entryUsd,x.exitUsd,x.costsFraction,x.benchmarkEntry,x.benchmarkExit].every(number) || x.entryUsd<=0 || x.exitUsd<0 || x.costsFraction<0 || x.benchmarkEntry<=0 || x.benchmarkExit<=0 ||
    !(time(x.publishedAt)>=start && time(x.evaluatedAt)<=end) || time(x.entryAt)!==time(x.publishedAt)+5*60000 || time(x.evaluatedAt)!==time(x.publishedAt)+DAY ||
    !refs(x.receiptIds,['archived-publication','historical-quote']))) reasons.push('Need 10 distinct mature callouts across 3 assets, a complete cohort and fixed 5-minute entry/24-hour outcome quotes.');
  if (reasons.length) { result.reasons=[...new Set(reasons)]; return result; }

  // All transforms below are declared research policy, not fitted predictive probabilities.
  const growth = dailyReturns.reduce((g,r)=>g*(1+r),1), benchmark = benchmarkReturns.reduce((g,r)=>g*(1+r),1);
  const excess = growth/benchmark-1;
  let equity=1, peak=1, maxDrawdown=0;
  for (const r of dailyReturns) { equity*=1+r; peak=Math.max(peak,equity); maxDrawdown=Math.max(maxDrawdown,1-equity/peak); }
  const weekly: number[]=[];
  for (let i=0;i<28;i+=7) weekly.push(dailyReturns.slice(i,i+7).reduce((v,r)=>v*(1+r),1)/benchmarkReturns.slice(i,i+7).reduce((v,r)=>v*(1+r),1)-1);
  const costs = h.executions.map(x=>x.feesUsd/x.notionalUsd*10000+x.adverseSlippageBps);
  const calls = h.calls.map(x=>(x.exitUsd/x.entryUsd-x.costsFraction)/(x.benchmarkExit/x.benchmarkEntry)-1);
  const scores = [clamp(50+100*excess), clamp(100*(1-maxDrawdown)*.7+100*(1-median(concentration))*.3), weekly.filter(x=>x>0).length/weekly.length*100, clamp(100-median(costs)/5), clamp(50+100*median(calls))];
  if (![...scores,growth,benchmark,maxDrawdown,...costs,...calls].every(number)) { reasons.push('Non-finite arithmetic. No score returned.'); return result; }
  const metrics = [
    `${(excess*100).toFixed(2)}% benchmark-relative return over 30 days, after actual costs`,
    `${(maxDrawdown*100).toFixed(2)}% maximum drawdown; ${median(concentration).toFixed(3)} median portfolio HHI`,
    `${weekly.filter(x=>x>0).length}/4 non-overlapping weeks ahead of the benchmark`,
    `${median(costs).toFixed(1)} bps median fees plus adverse slippage`,
    `${(median(calls)*100).toFixed(2)}% median cost-adjusted, benchmark-relative callout outcome`,
  ];
  const interval=wilsonInterval(h.positions.filter(x=>x.netPnlUsd>0).length,h.positions.length)!;
  result.status='experimental';
  result.factors=result.factors.map((f,i)=>({...f,score:Math.round(scores[i]*10)/10,contribution:scores[i]*f.weight/100,metric:metrics[i]}));
  result.score=Math.round(result.factors.reduce((sum,f)=>sum+f.contribution!,0));
  result.diagnostics={timeWeightedReturn:growth-1,benchmarkReturn:benchmark-1,excessReturn:excess,maxDrawdown,medianHoldingsHHI:median(concentration),medianExecutionBps:median(costs),closedPositions:h.positions.length,winRate:h.positions.filter(x=>x.netPnlUsd>0).length/h.positions.length,nominalWinIntervalLow:interval[0],nominalWinIntervalHigh:interval[1],matureCallouts:h.calls.length};
  return result;
}
