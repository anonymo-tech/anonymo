import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFomoComparison } from '../components/dashboard/use-live-workspace.ts';
import { MODELS } from '../components/dashboard/data.ts';
import { CHAT_LIMITS, CHAT_CAPACITY } from '../lib/chat-limits.ts';
import { CHINESE_CHAT_MODELS } from '../lib/chinese-models.ts';
import { FEATURE_SWITCHES } from '../components/dashboard/feature-switches.ts';
import { SECOND_LOOK_SWITCHES } from '../lib/second-look/releases.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { assertEndpointReleased } from '../server/core/feature-release.ts';
import { fomoAnalysisPrompt } from '../lib/second-look/fomo.ts';
import { fomoPromptPresentation } from '../lib/second-look/fomo-presentation.ts';
const now=Date.now();
const chosen=['claude','gpt',CHINESE_CHAT_MODELS[0].key,CHINESE_CHAT_MODELS[1].key];
const routes=chosen.map((family,i)=>({id:'route-'+i,versionId:'version-'+i,version:1,modelId:'native-'+family,family,modality:'chat',available:true,expiresAt:new Date(now+600000).toISOString(),card:{reviewed:true},pricing:{maxInputBytes:CHAT_LIMITS.inputBytes,maxOutputTokens:CHAT_CAPACITY[family].outputTokens}}));
const room={id:'project',name:'Unrelated conversation',pinned:false,updatedAt:now,draft:'Other draft',selectedModels:['gemini'],turns:[{id:'old',prompt:'Unrelated private history',answers:[]}],live:{revision:1,historyCursor:'older'}};
test('saved FOMO prompt displays a title after reload without changing full stored evidence',()=>{
 const evidence={id:'saved-analysis',createdAt:new Date(now).toISOString(),input:{kind:'profile',url:'https://fomo.family/profile/tester',handle:'tester',chain:null,token:null,calloutId:null},title:'FOMO profile: @tester',state:'partial',callout:null,sources:[],limitations:['Limited public coverage']};
 const savedPrompt=fomoAnalysisPrompt(evidence);
 const reloaded=JSON.parse(JSON.stringify({prompt:savedPrompt}));
 assert.deepEqual(fomoPromptPresentation(reloaded.prompt),{title:evidence.title,sourcePrompt:savedPrompt});
 assert.equal(reloaded.prompt,savedPrompt);
 assert.match(reloaded.prompt,/Limited public coverage/);
});
test('ordinary chat, incomplete research and mismatched evidence keep their original presentation',()=>{
 for(const prompt of ['Ordinary user message','BEGIN UNTRUSTED EVIDENCE JSON','Title\n\nBEGIN UNTRUSTED EVIDENCE JSON\n\n{}\n\nEND UNTRUSTED EVIDENCE JSON'])assert.equal(fomoPromptPresentation(prompt),null);
 const malformed='Title\n\nYou are one of four independently selected research models. Produce an extensive, evidence-led analysis of this FOMO profile.\n\nBEGIN UNTRUSTED EVIDENCE JSON\n\n'+JSON.stringify({title:'Other title',input:{kind:'profile'},sources:[]})+'\n\nEND UNTRUSTED EVIDENCE JSON';
 assert.equal(fomoPromptPresentation(malformed),null);
});
test('FOMO preserves production 112-model catalog and accepts complete evidence above legacy32KiB',()=>{
 assert.equal(MODELS.length,112); assert.equal(CHINESE_CHAT_MODELS.length,107);
 const evidence='Evidence with @grok mention\n'+'E'.repeat(70000);
 const result=prepareFomoComparison(room,evidence,chosen,routes,now);
 assert.deepEqual(result.routes.map(r=>r.family),chosen);
 assert.equal(result.conversation.items.length,4);
 for(const [i,item] of result.conversation.items.entries()){
  assert.deepEqual(item.messages,[{role:'user',content:evidence}]);
  assert.equal(item.maxOutputTokens,CHAT_CAPACITY[chosen[i]].outputTokens);
  assert.equal(result.conversation.contexts[i].includedExchanges,0);
  assert.equal(result.conversation.contexts[i].olderHistoryNotLoaded,false);
 }
 assert.equal(result.auto,null);assert.deepEqual(result.mentions,[]);
});
test('FOMO native input limits reject oversized evidence without truncation',()=>{
 const limited=routes.map((r,i)=>i===2?{...r,pricing:{...r.pricing,maxInputBytes:40000}}:r);
 assert.throws(()=>prepareFomoComparison(room,'E'.repeat(50000),chosen,limited,now),{code:'PROMPT_TOO_LARGE'});
});
test('FOMO-only approval opens only its endpoint and leaves every other SecondLook tool blocked',()=>{
 const outer=FEATURE_SWITCHES.secondLook,saved={...SECOND_LOOK_SWITCHES};
 try{
  FEATURE_SWITCHES.secondLook=true;
  for(const name of Object.keys(SECOND_LOOK_SWITCHES))SECOND_LOOK_SWITCHES[name]=name==='fomo';
  assert.doesNotThrow(()=>assertEndpointReleased('second-look/fomo/analyze','POST'));
  for(const path of ['tokens/check','wallets','planning','signature/inspect','follow/traders','why-moved','tax/fixture/export','alerts','steady/purchase','guarded/buy','rooms/calls','networks/robinhood/receipt','telegram/link','mcp'])assert.throws(()=>assertEndpointReleased('second-look/'+path,'POST'),{code:'FEATURE_UNAVAILABLE'});
 }finally{FEATURE_SWITCHES.secondLook=outer;Object.assign(SECOND_LOOK_SWITCHES,saved)}
});

test('FOMO-only capabilities do not advertise or initialize held tool capabilities',async()=>{
 const outer=FEATURE_SWITCHES.secondLook,saved={...SECOND_LOOK_SWITCHES};
 try{
  FEATURE_SWITCHES.secondLook=true;
  for(const name of Object.keys(SECOND_LOOK_SWITCHES))SECOND_LOOK_SWITCHES[name]=name==='fomo';
  const response=await dispatch(new Request('https://conclave.example/api/second-look/capabilities'));
  assert.equal(response.status,200);
  const body=await response.json();
  for(const name of ['token','signature','telegram'])assert.deepEqual(body[name],{configured:false,reason:'FEATURE_UNAVAILABLE'});
 }finally{FEATURE_SWITCHES.secondLook=outer;Object.assign(SECOND_LOOK_SWITCHES,saved)}
});
