import assert from 'node:assert/strict';
import test from 'node:test';
import {EMPTY_DECISION,isDecisionDrafts,saveDecisionDraft,decisionReady,decisionDownload} from '../lib/decision-worksheet.ts';
const draft=(id='a')=>({...EMPTY_DECISION,version:1,id,title:'A choice',updatedAt:1});
test('saved decision drafts preserve independent copies and enforce storage limits',()=>{
 const original=[draft()],updated={...draft(),question:'Updated'};
 assert.equal(saveDecisionDraft(original,updated).length,1);assert.equal(original[0].question,'');
 assert.equal(saveDecisionDraft(original,draft('b')).length,2);
 assert.equal(isDecisionDrafts([draft(),draft()]),false);
 assert.equal(isDecisionDrafts([{...draft(),input:'x'.repeat(6001)}]),false);
 assert.equal(isDecisionDrafts([{...draft(),version:2}]),false);
 assert.throws(()=>saveDecisionDraft(Array.from({length:20},(_,i)=>draft(String(i))),draft('new')));
});
test('worksheet review requires evidence, criteria and choice alternatives; exports no evaluated result',()=>{
 assert.equal(decisionReady(EMPTY_DECISION),false);
 const ready={...EMPTY_DECISION,question:'Which option?',input:'Evidence',criteria:'Cost'};
 assert.equal(decisionReady(ready),true);
 assert.equal(decisionReady({...ready,options:['One']}),false);
 assert.equal(decisionReady({...ready,kind:'score',options:[]}),true);
 const saved=JSON.parse(decisionDownload(ready));assert.equal(saved.result,null);assert.equal(saved.requiresReview,true);assert.equal(saved.status,'not_evaluated');
});
import {parseDecisionImport,DECISION_IMPORT_MAX_BYTES} from '../lib/decision-worksheet.ts';
test('decision imports round-trip fields without trusting result or evaluated claims',()=>{
 const fields={...EMPTY_DECISION,question:'Pick a vendor',input:'Evidence',criteria:'Reliability'};
 assert.deepEqual(parseDecisionImport(decisionDownload(fields)),fields);
 const forged={...JSON.parse(decisionDownload(fields)),result:'Guaranteed answer',requiresReview:false,status:'approved'};
 const parsed=parseDecisionImport(JSON.stringify(forged));assert.equal('result' in parsed,false);assert.equal('status' in parsed,false);
 assert.deepEqual(parseDecisionImport(decisionDownload({...fields,kind:'score'})).options,[]);
});
test('decision import rejects oversized, malformed, unrecognized and unsafe-shaped fields',()=>{
 for(const value of ['no json','null','[]','{"__proto__":{}}',JSON.stringify({...EMPTY_DECISION,kind:'execute'}),JSON.stringify({...EMPTY_DECISION,input:'x'.repeat(6001)}),JSON.stringify({...EMPTY_DECISION,question:{html:'script'}}),JSON.stringify({...EMPTY_DECISION,options:Array(31).fill('a')})])assert.throws(()=>parseDecisionImport(value));
 assert.throws(()=>parseDecisionImport('x'.repeat(DECISION_IMPORT_MAX_BYTES+1)));
 assert.throws(()=>parseDecisionImport('中'.repeat(DECISION_IMPORT_MAX_BYTES/2)));
});
