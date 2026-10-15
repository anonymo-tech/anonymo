import test from 'node:test';
import assert from 'node:assert/strict';
import { isFomoTopTenBundle, fomoTopTenSummary } from '../lib/second-look/fomo-top10.ts';
import { publicFomoRoute, savedFomoProfile } from '../server/second-look/fomo-snapshots.ts';
import { publishFomoSnapshot } from './publish-fomo-snapshot.mjs';
import { parseFomoInput } from '../lib/second-look/fomo.ts';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { publicCallStudy, callEntry } from '../lib/second-look/fomo-call-study.ts';

const at = '2026-10-15T20:00:00.000Z';
const url = 'https://api.fomo-api.com/v1/leaderboard?window=30d&limit=10&board=fomo-parity';
function bundle() {
  return { schemaVersion:1, generatedAt:at, leaderboard:{window:'30d',url,fetchedAt:at,observedAt:at,sha256:'a'.repeat(64),attribution:'FOMO-reported via FOMO API'},
    entries:Array.from({length:10},(_,i)=>{const handle='fixture'+i;return {rank:i+1,handle,analysis:{id:'fixture-'+i,createdAt:at,input:parseFomoInput('@'+handle),title:'FOMO profile: @'+handle,state:'partial',callout:null,limitations:['Public fixture'],sources:[{id:'public-profile-30d',label:'FOMO-reported 30d board',url,fetchedAt:at,observedAt:at,state:'partial',note:'Third-party attribution',data:{window:'30d',source:'fomo',board:'fomo-parity',pnlBasis:'mark-to-market',syncedAt:at,trader:{rank:i+1,handle}}}]}};})};
}
test('ten ranked identities and original source dates are mandatory; no private context enters the public collection',()=>{
  assert.equal(isFomoTopTenBundle(bundle()),true);
  const edits=[b=>b.entries.pop(),b=>b.entries[0].rank=2,b=>b.entries[0].handle='fixture1',b=>b.entries[0].analysis.input=parseFomoInput('@someoneelse'),b=>b.entries[0].analysis.sources[0].data.source='computed',b=>b.entries[0].analysis.sources[0].data.trader.rank=10,b=>b.entries[0].analysis.sources[0].fetchedAt='2030-01-01T00:00:00Z',b=>b.entries[0].analysis.sources.push({...b.entries[0].analysis.sources[0],id:'supplied-context',data:{text:'Private question'}})];
  for(const edit of edits){const b=bundle();edit(b);assert.equal(isFomoTopTenBundle(b),false)}
  const summary=fomoTopTenSummary(bundle());assert.equal(summary.entries.length,10);assert(summary.entries.every(e=>e.score===null));
});
test('public reads select only an exact top-ten handle and never start a source fetch or model job',async()=>{
  let queries=0;const b=bundle(),pool={query:async sql=>{queries++;assert.match(sql,/SELECT document FROM fomo_public_snapshots/);return{rows:[{document:b}]}}};
  assert.equal((await savedFomoProfile(pool,'FIXTURE2')).input.handle,'fixture2');
  await assert.rejects(savedFomoProfile(pool,'fixture'),{code:'FOMO_PROFILE_NOT_COLLECTED'});
  const board=await publicFomoRoute(pool,new Request('https://conclave.test/api/second-look/fomo/leaderboard'),'second-look/fomo/leaderboard');assert.equal((await board.json()).entries.length,10);
  const before=queries;assert.equal(await publicFomoRoute(pool,new Request('https://conclave.test',{method:'POST'}),'second-look/fomo/leaderboard'),null);assert.equal(queries,before);
});
test('repeated calls on one asset use each call’s retained date window',()=>{
  const mint='So11111111111111111111111111111111111111112';
  const calls=['2026-10-10T12:00:00Z','2026-10-12T12:00:00Z'].map((createdAt,i)=>({id:'call-'+i,createdAt,text:'Public fixture',textTruncated:false,network:'solana',token:{address:mint,symbol:'TEST'},author:{userHandle:'fixture0'},position:null}));
  const a=bundle().entries[0].analysis;
  a.sources.push({id:'public-trader-calls',state:'partial',data:{method:'public-trader-page',items:calls}});
  for(const [i,c]of calls.entries()){const start=callEntry(c.createdAt);a.sources.push({id:`call-price-${i}-0`,state:'partial',data:{method:'public-five-minute-ohlcv',network:'solana',token:mint,callId:c.id,rawSha256:'b'.repeat(64),candles:Array.from({length:292},(_,j)=>[start-900+j*300,j===291?i?120:80:100,80,1])}})}
  const study=publicCallStudy(a);assert.equal(study.measured,2);assert(study.outcomes[0].grossReturn<0);assert(study.outcomes[1].grossReturn>0);assert.equal(study.score,null);
});
test('snapshot ingestion is atomic, idempotent and rejects older batches with an isolated database',async t=>{
  const connection=process.env.CONCLAVE_TEST_DATABASE_URL;if(!connection){t.skip('isolated local database required');return;}
  const u=new URL(connection);assert(['127.0.0.1','localhost'].includes(u.hostname)&&u.pathname.endsWith('_test'));
  const pool=createDatabase(connection,1);
  try{
    await migrate(pool);await pool.query('TRUNCATE fomo_public_snapshots');const b=bundle(),now=Date.parse(at);
    assert.equal((await publishFomoSnapshot(pool,b,now)).changed,true);
    assert.equal((await publishFomoSnapshot(pool,b,now)).changed,false);
    const old=structuredClone(b);old.generatedAt='2026-10-15T19:59:00Z';await assert.rejects(publishFomoSnapshot(pool,old,now));
    const invalid=structuredClone(b);invalid.entries[1].rank=1;await assert.rejects(publishFomoSnapshot(pool,invalid,now));
    assert.deepEqual((await pool.query('SELECT document FROM fomo_public_snapshots')).rows[0].document,b);
  }finally{await pool.end()}
});
