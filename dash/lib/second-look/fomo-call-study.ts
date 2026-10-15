import type { FomoAnalysis, FomoSource } from './fomo.ts';

export const CALL_METHOD = 'public-calls-1.0.0';
export const CALL_FACTORS = [
  { id: 'outcome', label: '24-hour outcome', weight: 40 },
  { id: 'downside', label: 'Downside after the call', weight: 25 },
  { id: 'repeatability', label: 'Positive outcomes', weight: 20 },
  { id: 'activity', label: 'Market activity', weight: 15 },
] as const;
export type PublicCall = {
  id: string; createdAt: string; text: string; textTruncated: boolean;
  network: string; token: { address: string; symbol: string };
  author: { userHandle: string }; position: Record<string, unknown> | null;
};
/** Five-minute USD price observations: timestamp, open, low, traded (0/1).
 * Zero-volume rows retain the provider's last mark; freshness is checked below. */
export type PriceObservation = [number, number, number, number];
export type CallOutcome = {
  call: PublicCall; status: 'measured' | 'pending' | 'unavailable'; reason: string;
  entryAt: string; exitAt: string; entryUsd: number | null; exitUsd: number | null;
  grossReturn: number | null; scenarioReturn: number | null; adverseMove: number | null;
  activeShare: number | null; crossVenue: 'agrees' | 'one-venue' | 'conflict';
  sourceIds: string[];
};
export type PublicCallStudy = {
  version: string; score: number | null; label: 'Public call score';
  confidence: 'limited'; outcomes: CallOutcome[]; measured: number; pending: number;
  assets: number; published30d: number | null; sourceIds: string[];
  factors: { id: string; label: string; weight: number; score: number; contribution: number; reason: string }[];
  costRange: [number, number] | null; reasons: string[]; scope: string;
};
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp = (v: number) => Math.max(0, Math.min(100, v));
const mean = (xs: number[]) => xs.reduce((a,b)=>a+b,0)/xs.length;
const rounded = (n: number) => Math.round(n*10)/10;
const STEP = 300, DAY = 86400;
export const callEntry = (at: string) => Math.ceil((Date.parse(at)/1000+STEP)/STEP)*STEP;
const iso = (seconds: number) => new Date(seconds*1000).toISOString();
const key = (c: PublicCall) => c.network+':'+c.token.address;

function validCall(x: unknown, handle: string, now: number): x is PublicCall {
  return obj(x) && typeof x.id==='string' && typeof x.createdAt==='string' &&
    Number.isFinite(Date.parse(x.createdAt)) && Date.parse(x.createdAt)<=now && Date.parse(x.createdAt)>=now-30*DAY*1000 &&
    typeof x.text==='string' && x.text.length>0 && x.text.length<=8000 && typeof x.textTruncated==='boolean' &&
    obj(x.author) && typeof x.author.userHandle==='string' && x.author.userHandle.toLowerCase()===handle.toLowerCase() &&
    typeof x.network==='string' && ['solana','ethereum','base','bsc','monad','robinhood'].includes(x.network) &&
    obj(x.token) && typeof x.token.address==='string' && typeof x.token.symbol==='string' &&
    (x.network==='solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-f0-9]{40}$/).test(x.token.address);
}
function candles(s: FomoSource, c: PublicCall): PriceObservation[] | null {
  const d=s.data;
  if (s.state==='unavailable' || !d || d.method!=='public-five-minute-ohlcv' || d.network!==c.network || d.token!==c.token.address ||
    typeof d.rawSha256!=='string' || !/^[a-f0-9]{64}$/.test(d.rawSha256) ||
    !Array.isArray(d.candles) || !d.candles.length || d.candles.length>1000) return null;
  const rows=d.candles;
  if (rows.some(r=>!Array.isArray(r) || r.length!==4 || !r.every(finite) || r[0]%STEP!==0 || r[1]<=0 || r[2]<=0 || r[2]>r[1] || ![0,1].includes(r[3])) ||
    new Set(rows.map(r=>r[0])).size!==rows.length) return null;
  return [...rows].sort((a,b)=>a[0]-b[0]) as PriceObservation[];
}
function calculate(outcomes: CallOutcome[], cost: number) {
  const groups=new Map<string,CallOutcome[]>();
  for (const o of outcomes) { const k=key(o.call); groups.set(k,[...(groups.get(k)??[]),o]); }
  // Equal weight per asset, then per call. Repeated promotion cannot multiply a token's weight.
  const byAsset=[...groups.values()];
  const returns=byAsset.map(g=>mean(g.map(o=>(1+o.grossReturn!)*(1-cost)-1)));
  const adverse=byAsset.map(g=>mean(g.map(o=>o.adverseMove!)));
  const wins=byAsset.map(g=>mean(g.map(o=>(1+o.grossReturn!)*(1-cost)-1>0 ? 1:0)));
  const activity=byAsset.map(g=>mean(g.map(o=>o.activeShare!)));
  const values=[mean(returns.map(r=>clamp(50+100*r))),mean(adverse.map(d=>clamp(100*(1-d/.5)))),mean(wins)*100,mean(activity.map(a=>clamp(a/.5*100)))];
  return { values, score:Math.round(values.reduce((s,v,i)=>s+v*CALL_FACTORS[i].weight/100,0)), averageReturn:mean(returns), averageAdverse:mean(adverse), positiveShare:mean(wins), activeShare:mean(activity) };
}

/** Descriptive score for a bounded, dated public-call sample. It is deliberately
 * distinct from the account-wide reconciled performance model. No LLM output,
 * reported PnL, popularity or missing factor can increase this score. */
export function publicCallStudy(a: FomoAnalysis): PublicCallStudy | null {
  const handle=a.input.handle ?? a.callout?.author;
  const source=a.sources.find(s=>s.id==='public-trader-calls' && s.state!=='unavailable' && s.data?.method==='public-trader-page');
  if (!handle || !source || !Array.isArray(source.data?.items)) return null;
  const now=Date.parse(a.createdAt), calls=source.data.items.filter(c=>validCall(c,handle,now));
  if (!calls.length || calls.length>20 || new Set(calls.map(c=>c.id)).size!==calls.length || new Set(calls.map(c=>key(c)+':'+c.createdAt)).size!==calls.length) return null;
  const prices=a.sources.filter(s=>/^call-price-\d+-[01]$/.test(s.id));
  const outcomes:CallOutcome[]=calls.map(c=>{
    const entry=callEntry(c.createdAt), end=entry+DAY;
    const o:CallOutcome={call:c,status:'unavailable',reason:'Historical prices are unavailable for this evaluation window.',entryAt:iso(entry),exitAt:iso(end),entryUsd:null,exitUsd:null,grossReturn:null,scenarioReturn:null,adverseMove:null,activeShare:null,crossVenue:'one-venue',sourceIds:[source.id]};
    // Wait until the exit candle has finished so provider responses are stable.
    if ((end+STEP)*1000>now) return {...o,status:'pending',reason:'The fixed 24-hour evaluation window has not finished.'};
    // Retained histories have separate windows for repeated calls on the same asset.
    // Select observations covering this exact call; another date is not interchangeable.
    const venueSource = (venue: number) => {
      const candidates = prices.filter(s=>s.id.endsWith('-'+venue) && s.data?.network===c.network && s.data?.token===c.token.address &&
        (s.data?.callId === undefined || s.data.callId === c.id));
      return candidates.find(s=>{const r=candles(s,c);return r?.some(x=>x[0]===entry) && r.some(x=>x[0]===end);}) ?? candidates[0];
    };
    const primary=venueSource(0);
    const rows=primary ? candles(primary,c) : null;
    if (!rows || !primary) return o;
    const lookup=new Map(rows.map(r=>[r[0],r]));
    const first=lookup.get(entry), last=lookup.get(end), path=rows.filter(r=>r[0]>=entry && r[0]<end);
    if (!first || !last || path.length!==DAY/STEP) return {...o,reason:'The 24-hour price path has missing intervals. No return was filled in.'};
    const fresh=(t:number) => rows.some(r=>r[0]>=t-900 && r[0]<=t && r[3]===1);
    if (!fresh(entry) || !fresh(end)) return {...o,reason:'An entry or exit mark has no observed trade within 15 minutes.'};
    o.sourceIds.push(primary.id);
    const secondary=venueSource(1);
    const other=secondary ? candles(secondary,c) : null;
    if (other && secondary) {
      const byTime=new Map(other.map(r=>[r[0],r])), e=byTime.get(entry), x=byTime.get(end);
      const freshOther=(t:number)=>other.some(r=>r[0]>=t-900 && r[0]<=t && r[3]===1);
      if (e && x && freshOther(entry) && freshOther(end)) {
        o.sourceIds.push(secondary.id);
        if (Math.max(Math.abs(e[1]/first[1]-1),Math.abs(x[1]/last[1]-1))>.1)
          return {...o,crossVenue:'conflict',reason:'Two venues disagree by more than 10% at an endpoint. The call is excluded pending review.'};
        o.crossVenue='agrees';
      }
    }
    const gross=last[1]/first[1]-1;
    return {...o,status:'measured',reason:o.crossVenue==='agrees'?'24-hour price path measured; endpoints agree across two venues.':'24-hour price path measured on one venue; no usable second-venue check.',entryUsd:first[1],exitUsd:last[1],grossReturn:gross,scenarioReturn:(1+gross)*.99-1,adverseMove:Math.max(0,1-Math.min(...path.map(r=>r[2]))/first[1]),activeShare:path.filter(r=>r[3]===1).length/path.length};
  });
  const measured=outcomes.filter(o=>o.status==='measured'), assets=new Set(measured.map(o=>key(o.call))).size;
  const eligible=measured.length>=3 && assets>=2;
  const calc=eligible?calculate(measured,.01):null;
  const reasons=calc ? [
    `${(calc.averageReturn*100).toFixed(1)}% asset-balanced 24-hour price return in the 1% total-cost scenario.`,
    `${(calc.averageAdverse*100).toFixed(1)}% average adverse move after the calls, balanced by asset.`,
    `${measured.filter(o=>o.scenarioReturn!>0).length}/${measured.length} measured calls finished positive in that scenario. Repeated assets share weight.`,
    `${Math.round(calc.activeShare*100)}% of five-minute intervals contained trades, balanced by asset.`,
  ] : ['At least three measurable calls across two assets are needed for the public-call score.'];
  return {
    version:CALL_METHOD,score:calc?.score??null,label:'Public call score',confidence:'limited',outcomes,measured:measured.length,pending:outcomes.filter(o=>o.status==='pending').length,assets,
    published30d:finite(source.data.published30d)?source.data.published30d:null,sourceIds:[...new Set(outcomes.flatMap(o=>o.sourceIds))],
    factors:calc?CALL_FACTORS.map((f,i)=>({...f,score:rounded(calc.values[i]),contribution:rounded(calc.values[i]*f.weight/100),reason:reasons[i]})):[],
    costRange:calc?[Math.min(calculate(measured,0).score,calculate(measured,.02).score),Math.max(calculate(measured,0).score,calculate(measured,.02).score)]:null,
    reasons,scope:`${measured.length} measured calls across ${assets} assets from ${calls.length} publicly displayed calls. This grades a standardized 24-hour long-exposure scenario, not the author's intended horizon, actual trades, entire portfolio or future returns.`,
  };
}
