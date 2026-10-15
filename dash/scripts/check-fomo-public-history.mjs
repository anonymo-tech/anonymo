import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePublicTraderPage,collectPublicCallHistory,readPublicHistory} from '../server/second-look/fomo-public-history.ts';
import {publicCallStudy,callEntry} from '../lib/second-look/fomo-call-study.ts';
import {parseFomoInput,fomoAnalysisPrompt} from '../lib/second-look/fomo.ts';
import {fomoAnalysisResponse} from '../lib/client/fomo-contracts.ts';
import {scanPrompt} from '../lib/guards/index.ts';
import {collectFomoAnalysis} from '../server/second-look/fomo.ts';
import {fomoPromptPresentation} from '../lib/second-look/fomo-presentation.ts';
const at='2026-10-05T12:00:00Z', a='0x'+'1'.repeat(40), b='0x'+'2'.repeat(40), sha='a'.repeat(64);
const clone=structuredClone;
function source(id,data,url='https://fomolens.app/trader/example') {return {id,label:id,url,fetchedAt:at,observedAt:null,state:'partial',note:'Test observation',data};}
function fixture(){
  const calls=[['a1',a,'2026-10-01T00:00:00Z'],['a2',a,'2026-10-02T00:00:00Z'],['b1',b,'2026-10-01T00:00:00Z']].map(([id,address,createdAt])=>({id,createdAt,text:'Buy this token.',textTruncated:false,network:'base',token:{address,symbol:id[0].toUpperCase()},author:{userHandle:'example'},position:null}));
  const prices=[a,b].map((token,i)=>{
    const start=callEntry(calls[0].createdAt),end=callEntry(calls[i===0?1:2].createdAt)+86400;
    const candles=[];
    for(let t=start-900;t<=end;t+=300){let open=100;
      if(t===end)open=i===0?120:90;
      // For A's first exit, mark 120, then reset at the next entry. These
      // coincident boundaries intentionally demonstrate identical shared marks.
      if(i===0 && t===start+86400)open=120;
      candles.push([t,open,i===0?90:80,1]);
    }
    return source(`call-price-${i}-0`,{method:'public-five-minute-ohlcv',network:'base',token,rawSha256:sha,candles},`https://api.geckoterminal.com/api/v2/networks/base/pools/${token}/ohlcv/minute`);
  });
  return {id:'test',createdAt:at,title:'FOMO profile: @example',input:parseFomoInput('@example'),state:'partial',callout:null,limitations:[],sources:[source('public-trader-calls',{method:'public-trader-page',published30d:3,items:calls}),...prices]};
}
const article=(created='2026-10-01T00:00:00Z',token=a)=>`<article class="call-row" aria-label="Call by @example on $A"><a href="/token/base/${token}">A</a><time class="call-time" dateTime="${created}"></time><p class="call-text">A &amp; B.</p><dl><dt>Position value</dt><dd title="—">—</dd></dl></article>`;
const page=(body)=>`<link rel="canonical" href="https://fomolens.app/trader/example"/><h1>@example</h1>${body}`;

test('free page parser matches the profile, deduplicates displayed cards and preserves timestamps',()=>{
 const r=parsePublicTraderPage(page(article()+article()),'example',at);assert.equal(r.items.length,1);assert.equal(r.items[0].text,'A & B.');assert.equal(r.items[0].position.valueUsd,null);assert.equal(r.items[0].createdAt,'2026-10-01T00:00:00.000Z');assert.match(r.rawSha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>parsePublicTraderPage(page(article()),'different',at));
 assert.equal(parsePublicTraderPage(page(article('2099-01-01')), 'example',at).items.length,0);
 assert.equal(parsePublicTraderPage(page(article('2026-10-01','https://evil.test')), 'example',at).items.length,0);
 assert.equal(parsePublicTraderPage(page(`<script>${article()}</script><style>${article()}</style>`),'example',at).items.length,0);
});
test('public history rejects unsupported and credential-bearing origins before network access',async()=>{
 for(const url of ['http://127.0.0.1/test','https://fomolens.app/api/v1/users/example/history','https://fomolens.app/api/public/lookup','https://x:y@fomolens.app/trader/example','https://fomolens.app/trader/example?cursor=paid','https://api.geckoterminal.com/redirect'])await assert.rejects(readPublicHistory(url,'html'));
});
test('bounded collector uses only the free page and exact base-token price routes',async()=>{
 const requests=[];
 const rows=Array.from({length:292},(_,i)=>[callEntry('2026-10-01T00:00:00Z')-900+i*300,100,110,90,100,10]);
 const read=async(u,k)=>{requests.push(u);if(k==='html')return page(article());if(u.endsWith('/pools'))return JSON.stringify({data:[{attributes:{address:a,reserve_in_usd:'10000',pool_created_at:'2026-09-01T00:00:00Z'},relationships:{base_token:{data:{id:'base_'+a}}}}]});return JSON.stringify({data:{attributes:{ohlcv_list:rows}},meta:{base:{address:a}}});};
 const result=await collectPublicCallHistory('example',at,{read});assert.equal(result.length,3);assert.equal(result[2].state,'partial');assert.equal(result[2].data.candles.length,292);assert.equal(requests.length,3);assert.ok(requests.every(u=>!u.includes('/api/v1/')&&!u.includes('/lookup')));
});
test('wrong token, malformed candles and unavailable providers never create a history',async()=>{
 const base=async(u,k)=>k==='html'?page(article()):u.endsWith('/pools')?JSON.stringify({data:[{attributes:{address:a,reserve_in_usd:'1',pool_created_at:'2026-09-01'},relationships:{base_token:{data:{id:'base_'+a}}}}]}):JSON.stringify({data:{attributes:{ohlcv_list:[]}},meta:{base:{address:b}}});
 const r=await collectPublicCallHistory('example',at,{read:base});assert.equal(r.at(-1).state,'unavailable');
 const unavailable=await collectPublicCallHistory('example',at,{read:async()=>{throw Error('No');}});assert.equal(unavailable[0].state,'unavailable');assert.equal(unavailable[0].data,null);
});
test('fixed entry is at least five minutes after publication and uses a deterministic grid',()=>{
 assert.equal(new Date(callEntry('2026-10-01T00:00:01Z')*1000).toISOString(),'2026-10-01T00:10:00.000Z');
 assert.equal(new Date(callEntry('2026-10-01T00:00:00Z')*1000).toISOString(),'2026-10-01T00:05:00.000Z');
});
test('score is reproducible from retained observations; reported PnL and followers have no influence',()=>{
 const a=fixture(),s=publicCallStudy(a);assert.equal(s.measured,3);assert.equal(s.assets,2);assert.equal(s.score,55);assert.equal(s.factors[0].score,49);assert.equal(s.factors[1].score,62.5);assert.equal(s.factors[2].score,25);assert.equal(s.score,Math.round(s.factors.reduce((n,f)=>n+f.contribution,0)));assert.deepEqual(s,publicCallStudy(a));
 a.sources.push(source('public-profile-24h',{trader:{handle:'example',pnlUsd:1e15,followers:1e12,verified:true}}));assert.deepEqual(publicCallStudy(a),s);assert.equal(fomoAnalysisResponse({analysis:a}),true);
});
test('scale, row ordering and source ordering do not alter the score',()=>{
 const a=fixture(),b=clone(a);for(const s of b.sources)if(s.data.candles)s.data.candles=s.data.candles.reverse().map(r=>[r[0],r[1]*100,r[2]*100,r[3]]);b.sources.reverse();assert.equal(publicCallStudy(b).score,publicCallStudy(a).score);
});
test('duplicate IDs, identity mismatch and unsupported call formats cannot manufacture points',()=>{
 const a=fixture();a.sources[0].data.items.push(clone(a.sources[0].data.items[0]));assert.equal(publicCallStudy(a),null);
 const b=fixture();b.input.handle='someoneElse';assert.equal(publicCallStudy(b),null);
 const c=fixture();c.sources[0].data.items[0].network='fake';assert.equal(publicCallStudy(c).score,null);
 const d=fixture();d.sources[0].data.items.push({...clone(d.sources[0].data.items[0]),id:'alternate-id'});assert.equal(publicCallStudy(d),null);
});
test('missing intervals, NaN, stale endpoint marks and mismatched assets abstain for affected calls',()=>{
 const mutations=[s=>s.data.candles.splice(10,1),s=>{s.data.candles[10][1]=NaN;},s=>s.data.candles.forEach(r=>r[3]=0),s=>{s.data.token=b;},s=>s.data.candles.push(clone(s.data.candles[0]))];
 for(const mutate of mutations){const a=fixture();mutate(a.sources[1]);const r=publicCallStudy(a);assert.equal(r.score,null);assert.ok(r.outcomes.some(o=>o.status==='unavailable'));}
});
test('pending calls are visibly pending, not scored as losses',()=>{
 const a=fixture();a.sources[0].data.items.push({...clone(a.sources[0].data.items[0]),id:'pending',createdAt:'2026-10-05T10:00:00Z'});const r=publicCallStudy(a);assert.equal(r.pending,1);assert.equal(r.score,publicCallStudy(fixture()).score);
});
test('second-venue contradictions are excluded rather than silently averaged away',()=>{
 const a=fixture();a.sources.push({...clone(a.sources[1]),id:'call-price-0-1'});a.sources.at(-1).data.candles.forEach(r=>{r[1]*=2;r[2]*=2;});const r=publicCallStudy(a);assert.equal(r.score,null);assert.equal(r.outcomes[0].crossVenue,'conflict');
});
test('deeper adverse moves and less trading activity cannot improve the respective factor',()=>{
 const a=fixture(),b=clone(a);b.sources[1].data.candles.forEach(r=>r[2]/=2);assert.ok(publicCallStudy(b).factors[1].score<publicCallStudy(a).factors[1].score);
 const c=clone(a);c.sources[1].data.candles.forEach((r,i)=>{if(i%2 && i>5 && i<280)r[3]=0;});assert.ok(publicCallStudy(c).factors[3].score<=publicCallStudy(a).factors[3].score);
});
test('prompt explains the canonical sample grade without inviting a new model-chosen rating',()=>{
 const prompt=fomoAnalysisPrompt(fixture());assert.match(prompt,/CONCLAVE PUBLIC CALL STUDY/);assert.match(prompt,/"label":"Public call score"/);assert.match(prompt,/score:null/);assert.match(prompt,/cost sensitivity/);assert.match(prompt,/standardized 24-hour long-exposure scenario/);assert.ok(!prompt.includes('"candles":'));
 assert.equal(fomoPromptPresentation(prompt)?.title,'FOMO profile: @example');
});
test('main profile collector connects public history without sending a pasted URL through to fetch',async()=>{
 let called=false;const r=await collectFomoAnalysis('@example',{now:new Date(at),read:async()=>{throw Error('Unavailable');},publicHistory:async(h,when)=>{called=true;assert.equal(h,'example');assert.equal(when,at.replace('Z','.000Z'));return fixture().sources;}});assert.ok(called);assert.equal(r.state,'partial');assert.equal(publicCallStudy(r).score,55);
});

test('real price query parameters and nested call assets do not trip or weaken the secret guard',()=>{
 const a=fixture();a.sources[1].url+='?aggregate=5&token=base&include_empty_intervals=true';
 const prompt=fomoAnalysisPrompt(a);assert.equal(scanPrompt(prompt).findings.length,0);assert.ok(!prompt.includes('token=base'));
});

test('public reader caches responses, preserves aborts and respects provider rate-limit cooldown',async()=>{
 const originalFetch=globalThis.fetch,originalNow=Date.now;
 let now=originalNow(),requests=0;
 Date.now=()=>now;
 const url=`https://api.geckoterminal.com/api/v2/networks/base/tokens/${a}/pools`;
 globalThis.fetch=async()=>{requests++;return requests===1?new Response('{"data":[]}',{headers:{'content-type':'application/json'}}):new Response('',{status:429,headers:{'retry-after':'60'}});};
 try{
  assert.equal(await readPublicHistory(url,'json'),'{"data":[]}');
  now+=1000;assert.equal(await readPublicHistory(url,'json'),'{"data":[]}');assert.equal(requests,1);
  await assert.rejects(readPublicHistory(url,'json',AbortSignal.abort()),{name:'AbortError'});
  now+=5000;await assert.rejects(readPublicHistory(url.replace(a,b),'json'),/429/);assert.equal(requests,2);
  await assert.rejects(readPublicHistory(url.replace(a,'0x'+'3'.repeat(40)),'json'),/429/);assert.equal(requests,2);
  assert.equal(await readPublicHistory(url,'json'),'{"data":[]}');
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
});
