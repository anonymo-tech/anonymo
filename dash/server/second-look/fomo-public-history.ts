import { createHash } from 'node:crypto';
import type { FomoSource } from '../../lib/second-look/fomo.ts';
import { FOMO_HANDLE, FOMO_CHAINS } from '../../lib/second-look/fomo.ts';
import { callEntry, type PublicCall, type PriceObservation } from '../../lib/second-look/fomo-call-study.ts';

const obj=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const date=(s:string)=>Number.isFinite(Date.parse(s))?new Date(s).toISOString():null;
const address=(chain:string,value:string)=>(chain==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[a-fA-F0-9]{40}$/).test(value);
const decode=(s:string)=>s.replace(/&(?:amp|lt|gt|quot|#x27|#39|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,(entity)=>{
  const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#x27;':"'",'&#39;':"'",'&apos;':"'",'&nbsp;':' '};
  if(named[entity.toLowerCase()])return named[entity.toLowerCase()];
  const n=entity.toLowerCase().startsWith('&#x')?parseInt(entity.slice(3),16):parseInt(entity.slice(2),10);
  return Number.isInteger(n)&&n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
});
const text=(s:string)=>decode(s.replace(/<[^>]*>/g,'')).trim();
const amount=(s:string|undefined)=>{if(!s || !/[0-9]/.test(s))return null;const n=Number(decode(s).replace(/[^0-9.+-]/g,''));return Number.isFinite(n)?n:null;};
const attr=(s:string,name:string)=>decode(new RegExp(`\\b${name}="([^"]*)"`,'i').exec(s)?.[1]??'');
const numericFacts=(s:string)=>Object.fromEntries([...s.matchAll(/<dt[^>]*>(.*?)<\/dt>\s*<dd([^>]*)>(.*?)<\/dd>/gs)].map(m=>[text(m[1]),amount(attr(m[2],'title')||text(m[3]))]));

/** Parse only text already rendered on the free page. No script execution,
 * hidden paid records, browser passes, wallet matching or pagination. */
export function parsePublicTraderPage(html:string,handle:string,at:string) {
  if (!FOMO_HANDLE.test(handle) || html.length>1_500_000 || !date(at)) throw Error('Invalid public page');
  const originalHtml=html;
  html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
  const canonical=/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(html)?.[1];
  if(canonical?.toLowerCase()!==`https://fomolens.app/trader/${handle.toLowerCase()}`)throw Error('Trader page mismatch');
  const heading=/<h1[^>]*>(.*?)<\/h1>/s.exec(html)?.[1];
  if(!heading || text(heading).replace(/^@/,'').toLowerCase()!==handle.toLowerCase())throw Error('Trader heading mismatch');
  const items:PublicCall[]=[];
  for(const match of html.matchAll(/<article\b[^>]*class="call-row"[^>]*>(.*?)<\/article>/gs)){
    const s=match[1], stamp=/<time[^>]*class="call-time"[^>]*dateTime="([^"]+)"/i.exec(s)?.[1];
    const token=/href="\/token\/([a-z]+)\/([^"?]+)"/.exec(s), body=/<p[^>]*class="call-text"[^>]*>(.*?)<\/p>/s.exec(s)?.[1];
    const author=/aria-label="Call by @([^ ]+) on /.exec(match[0])?.[1];
    if(!stamp || !date(stamp) || Date.parse(stamp)>Date.parse(at) || Date.parse(stamp)<Date.parse(at)-30*86400_000 ||
       !token || !FOMO_CHAINS.includes(token[1] as typeof FOMO_CHAINS[number]) || !address(token[1],token[2]) || !body || author?.toLowerCase()!==handle.toLowerCase())continue;
    const network=token[1], tokenAddress=network==='solana'?token[2]:token[2].toLowerCase(), createdAt=date(stamp)!;
    const id=hash(network+':'+tokenAddress+':'+createdAt).slice(0,24);
    const content=text(body).slice(0,8000);
    const symbol=decode(/aria-label="Call by @[^ ]+ on \$([^"<]+)"/.exec(match[0])?.[1]??tokenAddress.slice(0,8));
    const facts=numericFacts(s), positionTime=[...s.matchAll(/<time[^>]*dateTime="([^"]+)"/gi)].at(-1)?.[1];
    const position={valueUsd:facts['Position value']??null,realizedPnlUsd:facts['Realized PnL']??null,unrealizedPnlUsd:facts['Unrealized PnL']??null,observedAt:positionTime?date(positionTime):null};
    const existing=items.find(c=>c.id===id);
    if(existing && existing.text!==content)throw Error('Conflicting public call text');
    if(!existing)items.push({id,createdAt,text:content,textTruncated:content.endsWith('…'),network,token:{address:tokenAddress,symbol},author:{userHandle:handle},position});
  }
  if(items.length>20)throw Error('Public page exceeded call bound');
  items.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  const activity=/<(?:div|section)[^>]*class="[^"]*trader[^"]*"/.test(html);
  const daily=[...html.matchAll(/<tr[^>]*>\s*<t[dh][^>]*>([^<]+)<\/t[dh]>\s*<td[^>]*>(\d+)<\/td>/g)].slice(0,30).map(m=>({day:text(m[1]),count:Number(m[2])}));
  const total=/Last 30 UTC days[^<]*?([0-9,]+) total/.exec(html)?.[1];
  const profileFacts=numericFacts(html.slice(0,html.indexOf('Sampled PnL')));
  const avatar=/<img[^>]*class="trader-avatar"[^>]*src="([^"]+)"/.exec(html)?.[1] ?? /"url":\s*"(https:\/\/prod-fomo-profile-pics[^" ]+)"/.exec(html)?.[1];
  const observed=/<time[^>]*dateTime="([^"]+)"/i.exec(html)?.[1];
  return {items,published30d:total?Number(total.replaceAll(',','')):null,daily:activity?daily:[],rawSha256:hash(originalHtml),
    trader:{handle,displayName:text(/<p[^>]*class="trader-name"[^>]*>(.*?)<\/p>/s.exec(html)?.[1]??''),followers:profileFacts.Followers??null,fomoNumTrades:profileFacts['Profile trades']??null,avatarUrl:avatar?decode(avatar):null,fomoProfileSyncedAt:observed?date(observed):null}};
}

export type HistoryRead=(url:string,kind:'html'|'json',signal?:AbortSignal)=>Promise<string>;
const cache=new Map<string,{at:number,body:string}>();
let nextMarketRead=0;
let marketBackoffUntil=0;
const failure=(e:unknown)=>e instanceof Error && /^History HTTP (?:429|500|502|503|504)$/.test(e.message)?e.message:'Unavailable or invalid historical data';
export async function readPublicHistory(url:string,kind:'html'|'json',signal?:AbortSignal):Promise<string>{
  const u=new URL(url);
  const page=u.origin==='https://fomolens.app' && /^\/trader\/[A-Za-z0-9_]{1,64}$/.test(u.pathname) && !u.search && kind==='html';
  const api=u.origin==='https://api.geckoterminal.com' && /^\/api\/v2\/networks\/(solana|eth|base|bsc|monad|robinhood)\/(tokens\/(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[a-fA-F0-9]{40})\/pools|pools\/(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[a-fA-F0-9]{40,64})\/ohlcv\/minute)$/.test(u.pathname) && kind==='json' &&
    (u.search==='' || /^\?aggregate=5&limit=1000&currency=usd&token=base&include_empty_intervals=true&before_timestamp=\d{10}$/.test(u.search));
  if((!page&&!api)||u.username||u.password||u.hash||u.port)throw Error('Unapproved history URL');
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const cached=cache.get(url);if(cached && Date.now()-cached.at<(u.pathname.includes('/ohlcv/')?86400_000:300000))return cached.body;
  if(api){
    if(Date.now()<marketBackoffUntil)throw Error('History HTTP 429');
    const wait=Math.max(0,nextMarketRead-Date.now());
    if(wait>30000)throw Error('History HTTP 429');
    nextMarketRead=Math.max(Date.now(),nextMarketRead)+2200;
    if(wait)await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>signal?.removeEventListener('abort',abort);
      const timer=setTimeout(()=>{cleanup();resolve();},wait);
      const abort=()=>{clearTimeout(timer);cleanup();reject(new DOMException('Cancelled','AbortError'));};
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
  }
  if(api && Date.now()<marketBackoffUntil)throw Error('History HTTP 429');
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
  const r=await fetch(url,{signal:combined,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',headers:{Accept:kind==='html'?'text/html':'application/json','User-Agent':'ConclaveResearch/1.0'}});
  if(!r.ok){
    if(api && r.status===429){const retry=Number(r.headers.get('retry-after'));marketBackoffUntil=Date.now()+Math.min(300,Math.max(30,Number.isFinite(retry)?retry:60))*1000;}
    throw Error('History HTTP '+r.status);
  }
  if(r.redirected || (r.url && r.url!==url) || !(kind==='html'?/^text\/html\b/:/^application\/json\b/).test(r.headers.get('content-type')??''))throw Error('History source unavailable');
  const reader=r.body?.getReader();if(!reader)throw Error('Missing history body');
  const chunks:Uint8Array[]=[];let count=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>1_500_000)throw Error('History body too large');chunks.push(value);}}
  finally {void reader.cancel().catch(()=>{});}
  const all=new Uint8Array(count);let pos=0;for(const c of chunks){all.set(c,pos);pos+=c.length;}
  const body=new TextDecoder('utf-8',{fatal:true}).decode(all);
  if(cache.size>=64)cache.delete(cache.keys().next().value!);cache.set(url,{at:Date.now(),body});return body;
}

/** A bounded free-page sample plus public historical DEX prices. A maximum of
 * three assets and two venues each. No calls to metered history/lookup routes. */
export async function collectPublicCallHistory(handle:string,at:string,options:{signal?:AbortSignal;read?:HistoryRead}={}):Promise<FomoSource[]>{
  if(!FOMO_HANDLE.test(handle))throw Error('Invalid handle');
  const read=options.read??readPublicHistory, signal=options.signal, sources:FomoSource[]=[];
  const fetchedAt=(url:string)=>!options.read && cache.has(url)?new Date(cache.get(url)!.at).toISOString():at;
  const pageUrl='https://fomolens.app/trader/'+handle.toLowerCase();
  const unavailable=(id:string,label:string,url:string,note:string):FomoSource=>({id,label,url,fetchedAt:at,observedAt:null,state:'unavailable',note,data:null});
  let page:ReturnType<typeof parsePublicTraderPage>;
  try{page=parsePublicTraderPage(await read(pageUrl,'html',signal),handle,at);}catch{
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    return [unavailable('public-trader-calls','Public trader call history',pageUrl,'The free public trader page was unavailable. No missing history was inferred.')];
  }
  sources.push({id:'public-profile-page',label:'Public trader profile page',url:pageUrl,fetchedAt:fetchedAt(pageUrl),observedAt:page.trader.fomoProfileSyncedAt,state:'partial',note:'Public profile fields only. Observation time is retained; no wallet ownership is inferred.',data:{method:'public-trader-page',trader:page.trader,rawSha256:page.rawSha256}});
  sources.push({id:'public-trader-calls',label:'Dated public call history',url:pageUrl,fetchedAt:fetchedAt(pageUrl),observedAt:null,state:'partial',note:'Only calls rendered on the free trader page. Provider timestamps and position observations, not a complete history. IDs are local fingerprints, not native FOMO share IDs. Truncated text is identified.',data:{method:'public-trader-page',items:page.items,published30d:page.published30d,daily:page.daily,rawSha256:page.rawSha256}});
  const targets=[...new Map(page.items.filter(c=>(callEntry(c.createdAt)+86700)*1000<=Date.parse(at)).map(c=>[c.network+':'+c.token.address,c])).values()].slice(0,3);
  // Sequential assets and at most two concurrent venues keep the free endpoint burst bounded.
  for(let i=0;i<targets.length;i++){
    const target=targets[i], network=target.network==='ethereum'?'eth':target.network;
    const poolUrl=`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${target.token.address}/pools`;
    try{
      const raw=await read(poolUrl,'json',signal), parsed:unknown=JSON.parse(raw);
      if(!obj(parsed)||!Array.isArray(parsed.data))throw Error('Invalid pool discovery');
      const matching=parsed.data.filter(obj).filter(p=>{
        if(!obj(p.attributes)||!obj(p.relationships)||!obj(p.relationships.base_token)||!obj(p.relationships.base_token.data))return false;
        const base=p.relationships.base_token.data.id;
        return base===network+'_'+target.token.address && typeof p.attributes.address==='string' &&
          (network==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[a-fA-F0-9]{40,64}$/).test(p.attributes.address) &&
          Number.isFinite(Number(p.attributes.reserve_in_usd)) && Number(p.attributes.reserve_in_usd)>0;
      }).sort((a,b)=>Number((b.attributes as Record<string,unknown>).reserve_in_usd)-Number((a.attributes as Record<string,unknown>).reserve_in_usd)).slice(0,2);
      if(!matching.length)throw Error('No exact base-token pool');
      const calls=page.items.filter(c=>c.network===target.network && c.token.address===target.token.address && (callEntry(c.createdAt)+86700)*1000<=Date.parse(at));
      const end=Math.max(...calls.map(c=>callEntry(c.createdAt)+86400));
      const venues=await Promise.all(matching.map(async(p,j):Promise<FomoSource>=>{
        const attrs=p.attributes as Record<string,unknown>, pool=String(attrs.address), poolCreatedAt=String(attrs.pool_created_at);
        const url=`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/minute?aggregate=5&limit=1000&currency=usd&token=base&include_empty_intervals=true&before_timestamp=${end+300}`;
        try{
          const body=await read(url,'json',signal), d:unknown=JSON.parse(body);
          if(!obj(d)||!obj(d.data)||!obj(d.data.attributes)||!Array.isArray(d.data.attributes.ohlcv_list)||!obj(d.meta)||!obj(d.meta.base)||d.meta.base.address!==target.token.address)throw Error('Price identity mismatch');
          const data=d.data.attributes.ohlcv_list;
          if(data.length>1000 || data.some(r=>!Array.isArray(r)||r.length!==6||!r.every(x=>typeof x==='number'&&Number.isFinite(x))||r[0]%300!==0||r[1]<=0||r[2]<Math.max(r[1],r[4])||r[3]>Math.min(r[1],r[4])||r[3]<=0||r[5]<0)||new Set(data.map(r=>r[0])).size!==data.length)throw Error('Invalid price observations');
          const candles:PriceObservation[]=data.filter(r=>calls.some(c=>Date.parse(poolCreatedAt)<=Date.parse(c.createdAt) && r[0]>=callEntry(c.createdAt)-900 && r[0]<=callEntry(c.createdAt)+86400)).map(r=>[r[0],Number(r[1].toPrecision(12)),Number(r[3].toPrecision(12)),r[5]>0?1:0]);
          const payload={method:'public-five-minute-ohlcv',network:target.network,token:target.token.address,pool,poolCreatedAt,poolSelection:'Highest current reserve among exact base-token pools; chosen before fetching outcomes.',currentReserveUsd:Number(attrs.reserve_in_usd),rawSha256:hash(body),discoverySha256:hash(raw),candles};
          if(!candles.length || JSON.stringify(payload).length>64000)throw Error('No bounded price window');
          return {id:`call-price-${i}-${j}`,label:`${target.token.symbol} historical prices · venue ${j+1}`,url,fetchedAt:fetchedAt(url),observedAt:new Date(Math.max(...candles.map(r=>r[0]))*1000).toISOString(),state:'partial',note:'Five-minute USD pool marks, not executable quotes. Empty intervals use the prior mark; activity and freshness are checked. Current pool selection may introduce survivorship bias. Raw source hash and all scoring observations are retained.',data:payload};
        }catch(e){if(signal?.aborted)throw new DOMException('Cancelled','AbortError');return unavailable(`call-price-${i}-${j}`,target.token.symbol+' historical prices',url,failure(e)+'. No return was inferred.');}
      }));sources.push(...venues);
    }catch(e){if(signal?.aborted)throw new DOMException('Cancelled','AbortError');sources.push(unavailable(`call-price-${i}-0`,target.token.symbol+' historical prices',poolUrl,failure(e)+'. Exact-token historical markets were unavailable.'));}
  }
  return sources;
}
