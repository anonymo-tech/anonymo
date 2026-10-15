import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {researchFomoEvidence,fomoResearchTargets} from '../lib/second-look/fomo-research.ts';
import {scoreReconciledFomoHistory,wilsonInterval} from '../server/second-look/fomo-quantitative.ts';
import {collectFomoAnalysis} from '../server/second-look/fomo.ts';
import {fomoAnalysisPrompt,parseFomoInput} from '../lib/second-look/fomo.ts';
import {fomoAnalysisResponse} from '../lib/client/fomo-contracts.ts';
const fixture=JSON.parse(await readFile(new URL('../../../../fomo-research-preview/profile-snapshot.json',import.meta.url),'utf8'));
const clone=structuredClone;
const day=86400000,start=Date.parse('2026-09-01T00:00:00Z'),iso=n=>new Date(n).toISOString();
const mint='So11111111111111111111111111111111111111112';
function record(){
 const refs=['chain','quote','publication'];
 return {
 windowEnd:iso(start+30*day), attribution:'published-wallet-confirmed',complete:{ledger:true,inventory:true,fees:true,cashFlows:true,calloutCohort:true},
 receipts:refs.map((id,i)=>({id,sha256:String(i+1).repeat(64),observedAt:iso(start+30*day),method:['finalized-chain','historical-quote','archived-publication'][i]})),
 days:Array.from({length:30},(_,i)=>({date:iso(start+i*day),segments:[{start:iso(start+i*day),end:iso(start+(i+1)*day),openingNav:100,closingNav:101,benchmarkOpen:100,benchmarkClose:100.5,receiptIds:refs}],holdings:[{asset:'a',valueUsd:50},{asset:'b',valueUsd:50}],portfolioValueUsd:100,receiptIds:refs})),
 positions:Array.from({length:30},(_,i)=>({id:'p'+i,asset:'a'+i%3,openedAt:iso(start+i*day),closedAt:iso(start+i*day+3600000),netPnlUsd:1,costBasisUsd:100,receiptIds:refs})),
 executions:Array.from({length:30},(_,i)=>({id:'t'+i,at:iso(start+i*day),notionalUsd:100,feesUsd:.1,adverseSlippageBps:20,receiptIds:refs})),
 calls:Array.from({length:10},(_,i)=>({id:'c'+i,asset:'a'+i%3,publishedAt:iso(start+i*day),entryAt:iso(start+i*day+300000),evaluatedAt:iso(start+(i+1)*day),entryUsd:1,exitUsd:1.1,costsFraction:.01,benchmarkEntry:1,benchmarkExit:1.01,receiptIds:refs})),
 };
}
test('real snapshot cannot turn aggregate PnL, badges or follower counts into a performance grade',()=>{
 const r=researchFomoEvidence(fixture);assert.equal(r.score,null);assert.equal(r.checks.length,12);assert.equal(r.checks.find(c=>c.id==='ledger').status,'unknown');
 const inflated=clone(fixture);for(const s of inflated.sources)if(s.data?.trader){s.data.trader.pnlUsd=1e12;s.data.trader.followers=1e12;s.data.trader.verified=true;s.data.trader.score=100;}
 assert.deepEqual(researchFomoEvidence(inflated),r);
 assert.equal(scoreReconciledFomoHistory(null).score,null);
});
test('duplicated windows do not become independent factual source families',()=>{
 const a=clone(fixture),s=a.sources.find(s=>s.data?.trader);a.sources.push({...clone(s),id:'public-profile-7d'});
 assert.equal(researchFomoEvidence(a).sourceFamilies,researchFomoEvidence(fixture).sourceFamilies);
});
test('stale, future-dated, identity-mismatched and contradictory records are not verification',()=>{
 for(const mutate of [s=>{s.data.stale=true;},s=>{s.data.trader.syncedAt='2099-01-01';}]){const a=clone(fixture);a.sources.filter(s=>s.data?.trader).forEach(mutate);assert.notEqual(researchFomoEvidence(a).checks.find(x=>x.id==='freshness').status,'observed');}
 const a=clone(fixture);a.sources.find(s=>s.data?.trader).data.trader.source='contradictory';assert.equal(researchFomoEvidence(a).checks.find(x=>x.id==='accounting').status,'conflict');
 const b=clone(fixture);b.input.handle='unrelated';assert.equal(researchFomoEvidence(b).checks.find(x=>x.id==='identity').status,'unknown');
});
test('research targets are exact assets, bounded, deduplicated and attributable',()=>{
 assert.equal(fomoResearchTargets(fixture).length,3);
 const a=clone(fixture);a.input.handle='someoneelse';assert.equal(fomoResearchTargets(a).length,0);
 const s=fixture.sources.find(s=>s.data?.trader);const b=clone(fixture);b.sources.push(clone(s));assert.equal(fomoResearchTargets(b).length,3);
 s.data.trader.topHoldings.push({network:'solana',tokenAddress:'https://evil.test'});assert.equal(fomoResearchTargets(fixture).length,3);
});
test('a complete synthetic record yields reproducible factor contributions, without claiming validation',()=>{
 const a=scoreReconciledFomoHistory(record());assert.equal(a.status,'experimental');assert.equal(a.score,81);assert.equal(a.factors.find(f=>f.id==='risk').score,85);assert.equal(a.factors.find(f=>f.id==='execution').score,94);assert.equal(a.calibration,'not-validated-on-held-out-traders');assert.ok(a.score>=0&&a.score<=100);
 assert.equal(a.score,Math.round(a.factors.reduce((s,x)=>s+x.contribution,0)));assert.deepEqual(a,scoreReconciledFomoHistory(record()));
});
test('cash-flow scale does not change TWR: 100→101 is equivalent to 10,000→10,100',()=>{
 const a=record(),b=clone(a);b.days.forEach(d=>d.segments.forEach(s=>{s.openingNav*=100;s.closingNav*=100;}));assert.deepEqual(scoreReconciledFomoHistory(a),scoreReconciledFomoHistory(b));
 const c=record();c.days[0].segments=[{...c.days[0].segments[0],end:iso(start+day/2),closingNav:100},{...c.days[0].segments[0],start:iso(start+day/2),openingNav:10000,closingNav:10100,benchmarkOpen:100.5}];assert.equal(scoreReconciledFomoHistory(c).diagnostics.timeWeightedReturn,scoreReconciledFomoHistory(a).diagnostics.timeWeightedReturn);
});
test('missing, duplicate, mismatched-period and unreconciled records abstain instead of renormalizing weights',()=>{
 const mutations=[h=>h.complete.fees=false,h=>h.complete.cashFlows=false,h=>h.attribution='guessed',h=>h.days.pop(),h=>h.days[0].holdings.pop(),h=>h.positions[1].id=h.positions[0].id,h=>h.executions[0].receiptIds=['missing'],h=>h.calls[0].entryAt=h.calls[0].publishedAt,h=>h.calls[0].evaluatedAt=h.calls[0].publishedAt,h=>h.days[0].segments[0].openingNav=0,h=>h.days[0].segments[0].start='bad',h=>h.positions[0].closedAt='2099-01-01',h=>h.receipts[0].sha256='made up',h=>h.calls.pop()];
 for(const mutate of mutations){const h=record();mutate(h);const r=scoreReconciledFomoHistory(h);assert.equal(r.score,null);assert.ok(r.reasons.length);assert.ok(r.factors.every(f=>f.score===null));}
});
test('higher trading costs and deeper drawdowns cannot improve their factor score',()=>{
 const a=record(),b=clone(a);b.executions.forEach(x=>x.feesUsd*=100);const base=scoreReconciledFomoHistory(a),cost=scoreReconciledFomoHistory(b);assert.ok(cost.score<base.score);
 const c=clone(a);c.days[10].segments[0].closingNav=50;const risk=scoreReconciledFomoHistory(c);assert.ok(risk.factors.find(f=>f.id==='risk').score<base.factors.find(f=>f.id==='risk').score);
});
test('nominal win interval expands for small samples and is not a future-return probability',()=>{
 assert.ok(wilsonInterval(5,10)[0]<wilsonInterval(50,100)[0]);assert.equal(wilsonInterval(1,0),null);assert.equal(wilsonInterval(-1,10),null);
});
test('models receive explicit null-score instructions after untrusted material, no numerical example anchor',()=>{
 const prompt=fomoAnalysisPrompt(fixture);assert.ok(prompt.indexOf('CONCLAVE RESEARCH CHECKS')>prompt.indexOf('END UNTRUSTED EVIDENCE JSON'));assert.match(prompt,/use score:null/);assert.ok(!prompt.includes('"score":55'));assert.match(prompt,/Do not invent, estimate/);
});
test('profile collection researches exact held assets using public market data and rejects mismatched cached token reports',async()=>{
 const seen=[];
 const read=async url=>{seen.push(url);if(url.includes('leaderboard')&&url.includes('window=24h')){const d=clone(fixture.sources.find(s=>s.id==='public-profile-24h').data);return {data:{...d,data:[d.trader]},stale:false};}
 if(url.includes('dexscreener')){const [,chain,token]=url.match(/tokens\/v1\/([^/]+)\/(.+)$/);return{data:[{chainId:chain,baseToken:{address:token},liquidity:{usd:1000}}],stale:false};}throw Error('unavailable');};
 const a=await collectFomoAnalysis('@Chubbi230',{now:new Date(fixture.createdAt),read,tokenEvidence:async()=>({mint:'wrong',expiresAt:'2099-01-01',checks:[]})});
 assert.equal(a.sources.filter(s=>s.id.startsWith('market-position-')&&s.data).length,3);assert.equal(a.sources.find(s=>s.id.startsWith('token-position-')).state,'unavailable');assert.ok(fomoAnalysisResponse({analysis:a}));assert.ok(seen.every(x=>!x.includes('evil.test')));
});

const {readFomoMintFacts}=await import('../server/second-look/fomo-chain.ts');
const rawMint={context:{slot:457347539},value:{data:['AAAAAEN6ZQm8WoElRCO+F6YC4lLCkUBGmB65KiwHYjvwrCJ95E7wjXwDBwAGAQAAAABDemUJvFqBJUQjvhemAuJSwpFARpgeuSosB2I78KwifQ==','base64'],executable:false,owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}};
test('chain check validates network and raw mint layout, retains slot/receipt and does not claim trader ownership',async()=>{
 let checked=false;
 const s=await readFomoMintFacts(mint,undefined,new Date(fixture.createdAt),{genesis:async()=>{checked=true;},mint:async()=>rawMint});
 assert.ok(checked);assert.equal(s.data.method,'finalized-mint-bytes');assert.match(s.data.sha256,/^[a-f0-9]{64}$/);assert.equal(s.data.checks[0].sources[0].slot,'457347539');assert.equal(s.data.checks[0].facts.find(x=>x.key==='mintAuthority').value,null);
 assert.match(s.note,/not ownership/);
 const a=clone(fixture);a.sources.push(s);assert.equal(researchFomoEvidence(a).checks.find(x=>x.id==='token-controls').status,'checked');assert.ok(fomoAnalysisResponse({analysis:a}));
});
test('wrong network, non-mint, invalid bytes and cancellation cannot produce verified chain checks',async()=>{
 for(const raw of [{...rawMint,value:{...rawMint.value,owner:'wrong'}},{...rawMint,value:{...rawMint.value,data:['bad','base64']}},null]){
 const s=await readFomoMintFacts(mint,undefined,new Date(),{genesis:async()=>{},mint:async()=>raw});assert.equal(s.state,'unavailable');assert.equal(s.data,null);
 }
 const s=await readFomoMintFacts(mint,undefined,new Date(),{genesis:async()=>{throw Error('wrong genesis');},mint:async()=>{throw Error('must not run');}});assert.equal(s.data,null);
 const c=new AbortController();c.abort();await assert.rejects(()=>readFomoMintFacts(mint,c.signal,new Date()),/Cancelled/);
});
