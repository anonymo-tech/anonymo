import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { keys, generations, spendAlerts, ledger } from "../src/db/schema.ts";
import { activityQuery } from "../src/activity/query.ts";
import { picoToUsdString } from "../src/lib/money.ts";
import { loadConfig } from "../src/config.ts";
let h: Harness;
const address = (digit: string) => '0x' + digit.repeat(40);
beforeAll(async () => { h = await startRouter(); });
afterAll(async () => { await h?.close(); });
const at = new Date('2026-09-28T12:00:00Z');
const range = 'from=2026-09-28T00:00:00Z&to=2026-09-29T00:00:00Z';
type Key = { hash: string; auth: Record<string, string> };
async function feed(key: Key, query = range) {
  const r = await h.request('/api/v1/activity?' + query, { headers: key.auth });
  expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
  return r.json();
}
async function generation(key: Key, id: string, cost = 1n, ts = at) {
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash,key.hash));
  await h.ctx.db.insert(generations).values({ id, keyHash: key.hash, accountId: k.accountId, modelId: MODELS.llama.slug, providerId: 'alpha', mode: 'prepaid', cost, ts });
}
async function child(owner: Key) {
  const r = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Agent key' } });
  expect(r.status).toBe(201);
  const j = await r.json(); return { hash: j.data.hash, auth: { authorization: 'Bearer ' + j.key } };
}
test('requires a valid key; isolates accounts and limits ordinary keys to themselves', async () => {
  expect((await h.request('/api/v1/activity')).status).toBe(401);
  expect((await h.request('/api/v1/activity', { headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
  const owner = await h.fundedKey(), other = await h.fundedKey(), agent = await child(owner);
  await generation(owner,'isolation-owner'); await generation(agent,'isolation-agent'); await generation(other,'isolation-other');
  expect((await feed(owner)).data.map((r: any) => r.id).sort()).toEqual(['call:isolation-agent','call:isolation-owner']);
  expect((await feed(agent)).data.map((r: any) => r.id)).toEqual(['call:isolation-agent']);
  expect((await feed(other)).data.map((r: any) => r.id)).toEqual(['call:isolation-other']);
  expect((await feed(agent,range + '&key=' + other.hash)).data).toEqual([]);
  const ownerJson = JSON.stringify(await feed(owner)); expect(ownerJson).not.toContain(owner.hash); expect(ownerJson).not.toContain(agent.hash);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash,agent.hash));
  expect((await h.request('/api/v1/activity',{headers:agent.auth})).status).toBe(401);
});
test('sessions cannot expand their scope', async () => {
  const owner = await h.fundedKey();
  await generation(owner,'session-owner');
  const session = (await (await h.request('/api/v1/sessions',{method:'POST',headers:owner.auth,json:{budget_usd:1}})).json()).data;
  const sk = {hash:session.key_hash,auth:{authorization:'Bearer ' + session.key}};
  await generation(sk,'session-call');
  expect((await feed(sk)).data.map((r:any)=>r.id)).toEqual(['call:session-call']);
});
test('merges kinds without double charging and preserves exact signed decimal amounts', async () => {
  const key = await h.fundedKey(); const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash,key.hash));
  await generation(key,'exact-call',9007199254740993123n);
  await h.ctx.db.insert(spendAlerts).values({id:'exact-alert',accountId:k.accountId,keyHash:key.hash,kind:'threshold',state:{history:[{id:'exact-firing',at:at.toISOString(),delivery:{status:'sent',error:'delivery sentinel'}}]}});
  const page = await feed(key);
  expect(page.data.map((r:any)=>r.kind).sort()).toEqual(['alert','call']);
  expect(page.data.find((r:any)=>r.kind==='call').amount).toBe('-9007199.254740993123');
  expect(page.data.filter((r:any)=>r.kind!=='call').every((r:any)=>r.amount==='0')).toBe(true);
  expect(JSON.stringify(page)).not.toContain('sentinel');
  expect((await feed(key,range+'&model='+encodeURIComponent(MODELS.llama.slug))).data.map((r:any)=>r.kind)).toEqual(['call']);
  expect((await feed(key,range+'&kind=alert')).data).toHaveLength(1);
});
test('stable cursor pagination across kinds and sub-millisecond times binds the selected filters', async () => {
  const key=await h.fundedKey();
  for(let i=0;i<7;i++) await generation(key,'cursor-' + i,BigInt(i));
  const [k]=await h.ctx.db.select().from(keys).where(eq(keys.keyHash,key.hash));
  await h.ctx.db.insert(spendAlerts).values({id:'cursor-alert',accountId:k.accountId,keyHash:key.hash,kind:'threshold',state:{history:[{id:'cursor-firing',at:at.toISOString(),delivery:{status:'sent'}}]}});
  await h.ctx.db.execute(sql`update generations set ts=ts + interval '123 microseconds' where id='cursor-6'`);
  const all=[]; let cursor=''; let first;
  do { const page=await feed(key,range+'&limit=3'+(cursor?'&cursor='+cursor:'')); first ??=page; all.push(...page.data);cursor=page.next_cursor; } while(cursor);
  expect(all).toHaveLength(8);expect(new Set(all.map(r=>r.id)).size).toBe(8); expect(all[0].at).toBe('2026-09-28T12:00:00.000123Z');
  for(const suffix of ['&kind=call','&model=different','&to=2026-09-30T00:00:00Z']) expect((await h.request('/api/v1/activity?'+(suffix.startsWith('&to=') ? range.replace('2026-09-29T00:00:00Z','2026-09-30T00:00:00Z') : range+suffix)+'&cursor='+first.next_cursor,{headers:key.auth})).status).toBe(400);
  expect((await feed(key,'from=2026-09-28T12:00:00Z&to=2026-09-28T12:00:00.000123Z')).data).toHaveLength(7);
});
test('JSON and CSV exports use the same page, filter and cursor; formula cells are neutralized', async () => {
  const key=await h.fundedKey();await generation(key,'export-a');await generation(key,'export-b');
  await h.ctx.db.update(keys).set({name:'=SUM(1,2)'}).where(eq(keys.keyHash,key.hash));
  const page=await feed(key,range+'&limit=1&kind=call');
  const r=await h.request('/api/v1/activity?'+range+'&limit=1&kind=call&format=csv',{headers:key.auth});
  expect(r.status).toBe(200);expect(r.headers.get('x-next-cursor')).toBe(page.next_cursor);expect(r.headers.get('content-disposition')).toContain('activity.csv');
  const csv=await r.text();expect(csv).toContain('"\'=SUM(1,2)"');expect(csv).toContain('"-0.000000000001"'.replace('"-','"\'-'));expect(csv).toContain(page.data[0].id);expect(csv).not.toContain('export-a');
});
test('real calls retain receipts and do not also appear as ledger usage', async()=>{
  const key=await h.fundedKey();const response=await h.request('/api/v1/chat/completions',{method:'POST',headers:key.auth,json:{model:MODELS.llama.slug,messages:[{role:'user',content:'activity request sentinel'}],max_tokens:32}});
  expect(response.status).toBe(200);await response.text();
  const page=await feed(key,'kind=call');expect(page.data).toHaveLength(1);
  expect(page.data[0].verify_url).toBe('/verify/?r='+response.headers.get('x-receipt-id'));
  expect((await h.request(page.data[0].receipt_url)).status).toBe(200);
  expect((await feed(key,'kind=balance')).data).toEqual([]);
  expect(JSON.stringify(page)).not.toContain('activity request sentinel');
});
test('spending alert history follows its management-or-own-key access and never returns delivery secrets',async()=>{
  const owner=await h.fundedKey(), agent=await child(owner);const [k]=await h.ctx.db.select().from(keys).where(eq(keys.keyHash,owner.hash));
  const firing={id:'firing',at:at.toISOString(),delivery:{status:'failed',error:'delivery sentinel'},key_label:'Agent key'};
  await h.ctx.db.insert(spendAlerts).values([{id:'activity-spend-account',accountId:k.accountId,keyHash:null,kind:'threshold',state:{history:[firing]}},{id:'activity-spend-key',accountId:k.accountId,keyHash:agent.hash,kind:'threshold',state:{history:[firing]}}]);
  expect((await feed(owner,range+'&kind=alert')).data).toHaveLength(2);const page=await feed(agent,range+'&kind=alert');expect(page.data).toHaveLength(1);expect(page.data[0]).toMatchObject({amount:'0',status:'failed'});expect(JSON.stringify(page)).not.toContain('delivery sentinel');
});
test('generation-linked refunds remain visible while usage is represented once',async()=>{
  const key=await h.fundedKey();const [k]=await h.ctx.db.select().from(keys).where(eq(keys.keyHash,key.hash));await generation(key,'refunded-call',50n);
  await h.ctx.db.insert(ledger).values({id:'activity-refund',accountId:k.accountId,keyHash:key.hash,amount:17n,kind:'refund',ref:'activity-refund',generationId:'refunded-call',createdAt:at});
  const data=(await feed(key)).data;expect(data).toHaveLength(2);expect(data.find((r:any)=>r.kind==='balance')).toMatchObject({title:'Funds refunded',amount:'0.000000000017'});
});
test('strict query validation and exact decimal formatter',()=>{
  for(const q of [{limit:'101'},{limit:'0'},{kind:'unknown'},{format:'xml'},{cursor:'invalid'},{key:'bad'},{from:'bad'},{from:'2026-10-01T00:00:00Z',to:'2026-09-01T00:00:00Z'}])expect(()=>activityQuery(q)).toThrow();
  expect(picoToUsdString(0n)).toBe('0');expect(picoToUsdString(-1n)).toBe('-0.000000000001');
});
test('read-only activity works with existing production guards',()=>{
  const cfg=loadConfig({NODE_ENV:'production',ANONYMO_ENV:'production',RUNTIME_ROLE:'api',AUTO_MIGRATE:'false',HOST:'0.0.0.0',APP_SECRET:'fixture-'.repeat(6),ADMIN_TOKEN:'fixture-admin-'.repeat(3),PUBLIC_BASE_URL:'https://router.example',DATABASE_URL:'postgres://fixture:fixture-only-credential@localhost/activity',REDIS_URL:'redis://:fixture-only-credential@localhost:6379',CREDITS_ADDRESS:address('1'),CALLPAY_ADDRESS:address('1'),PROVIDER_BOND_ADDRESS:address('1'),RECEIPT_ANCHOR_ADDRESS:address('1'),ROUTER_PRIVATE_KEY:'0x'+'3'.repeat(64)});
  expect(cfg.production).toBe(true);
});
