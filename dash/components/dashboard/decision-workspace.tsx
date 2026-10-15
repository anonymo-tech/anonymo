'use client';
import {useState,type ChangeEvent} from 'react';
import {ShieldCheck} from 'lucide-react';
import {featureOn} from './feature-switches';
import {useDeviceSetting} from './use-device-setting';
import {scanPrompt} from '../../lib/guards';
import {DECISION_IMPORT_MAX_BYTES,parseDecisionImport,EMPTY_DECISION,EMPTY_DECISION_DRAFTS,decisionReady,decisionDownload,isDecisionDrafts,saveDecisionDraft,type DecisionDraft,type DecisionFields} from '../../lib/decision-worksheet';
import '@/app/dashboard/decision-workspace.css';

export function DecisionWorkspace({accountId,onToast}:{accountId:string;onToast:(message:string)=>void}){
 const [fields,setFields]=useState<DecisionFields>(EMPTY_DECISION),[name,setName]=useState(''),[activeId,setActiveId]=useState<string|null>(null),[selected,setSelected]=useState(''),[replacement,setReplacement]=useState<DecisionDraft|null>(null),[reviewed,setReviewed]=useState(false),[message,setMessage]=useState(''),[imported,setImported]=useState<DecisionFields|null>(null);
 const drafts=useDeviceSetting(`conclave:decision-drafts:v1:${accountId}`,EMPTY_DECISION_DRAFTS,isDecisionDrafts,featureOn('decisionDrafts'));
 function change(key:keyof DecisionFields,value:string|string[]){setFields(current=>({...current,[key]:value}));setReviewed(false);setMessage('');}
 function load(draft:DecisionDraft){setFields({kind:draft.kind,question:draft.question,input:draft.input,criteria:draft.criteria,options:draft.options});setName(draft.title);setActiveId(draft.id);setSelected(draft.id);setReviewed(false);setReplacement(null);setMessage('Worksheet opened.');}
 function save(asNew=false){
  const title=(name.trim()||fields.question.trim()).slice(0,80);
  if(!title){setMessage('Give this worksheet a name or question first.');return;}
  if(scanPrompt([title,fields.question,fields.input,fields.criteria,...fields.options].join('\n')).findings.some(item=>item.severity==='block')){setMessage('Remove or redact the detected secret before saving.');return;}
  const draft:DecisionDraft={...fields,version:1,id:!asNew&&activeId?activeId:crypto.randomUUID(),title,updatedAt:Date.now()};
  try{drafts.save(saveDecisionDraft(drafts.value,draft));setActiveId(draft.id);setName(title);setSelected(draft.id);setMessage('Worksheet saved on this device.');}
  catch(error){setMessage(error instanceof Error?error.message:'The worksheet could not be saved.');}
 }
 function download(){const url=URL.createObjectURL(new Blob([decisionDownload(fields)],{type:'application/json;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='conclave-decision-draft.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);onToast('Decision draft downloaded.');}
 async function importFile(event:ChangeEvent<HTMLInputElement>){
  const file=event.target.files?.[0];event.target.value='';if(!file)return;
  setMessage('');setImported(null);
  if(file.size>DECISION_IMPORT_MAX_BYTES){setMessage('Choose a JSON worksheet smaller than 100 KB.');return;}
  try{setImported(parseDecisionImport(await file.text()));}catch(error){setMessage(error instanceof Error?error.message:'The worksheet could not be imported.');}
 }
 const ready=decisionReady(fields);
 return <section className="cp-page cp-decisions">
  <header className="cp-heading"><div><h1 className="cp-title">Decisions</h1><p className="cp-description">Write the question, weigh the evidence and decide what matters.</p></div></header>
  {featureOn('decisionDrafts')&&<section className="dw-saved" aria-label="Saved decision worksheets">
   <div className="dw-saved-top"><label>Worksheet name<input aria-label="Worksheet name" value={name} maxLength={80} onChange={event=>setName(event.target.value)} placeholder="Give this decision a name"/></label><button className="cp-button cp-button--ink" type="button" disabled={!drafts.loaded} onClick={()=>save()}>Save worksheet</button>{activeId&&<button className="cp-button" type="button" onClick={()=>save(true)}>Save a copy</button>}</div>
   <div className="dw-saved-open"><label>Saved worksheets<select value={selected} onChange={event=>setSelected(event.target.value)}><option value="">Choose a worksheet</option>{drafts.value.map(draft=><option value={draft.id} key={draft.id}>{draft.title}</option>)}</select></label><button className="cp-button" type="button" disabled={!selected} onClick={()=>{const found=drafts.value.find(draft=>draft.id===selected);if(found)setReplacement(found);}}>Open</button><button className="cp-text-button" type="button" disabled={!selected} onClick={()=>{drafts.save(drafts.value.filter(draft=>draft.id!==selected));if(activeId===selected)setActiveId(null);setSelected('');setMessage('Saved copy removed. The open worksheet is unchanged.');}}>Delete saved copy</button></div>
   <p>Saved on this device for this account.</p>
   {replacement&&<div className="dw-replace"><p>Open “{replacement.title}”? Unsaved changes in this worksheet will be replaced.</p><button className="cp-button cp-button--ink" type="button" onClick={()=>load(replacement)}>Open worksheet</button><button className="cp-button" type="button" onClick={()=>setReplacement(null)}>Keep current worksheet</button></div>}
   {drafts.error&&<output>{drafts.error}</output>}
  </section>}
  {featureOn('decisionImport')&&<div className="dw-import">
   <label className="cp-button">Import worksheet<input className="po-sr-only" type="file" accept=".json,application/json" aria-label="Import decision worksheet" onChange={event=>void importFile(event)}/></label>
   {imported&&<section aria-label="Review imported worksheet"><h2>Open this worksheet?</h2><p>{imported.question||'Untitled worksheet'}</p><small>{imported.input.length.toLocaleString()} evidence characters · {imported.kind==='choice'?`${imported.options.length} options`:'Rubric included'}</small><p>Your current unsaved worksheet will be replaced. Imported answers and review claims are ignored.</p><button type="button" className="cp-button cp-button--ink" onClick={()=>{setFields(imported);setName(imported.question.slice(0,80));setActiveId(null);setSelected('');setReviewed(false);setImported(null);setReplacement(null);setMessage('Worksheet imported. Review it before using it.');}}>Open imported worksheet</button><button type="button" className="cp-button" onClick={()=>setImported(null)}>Cancel import</button></section>}
  </div>}
  {message&&<output className="dw-message">{message}</output>}
  <div className="cp-decision-layout">
   <form className="cp-form-paper" onSubmit={event=>{event.preventDefault();if(ready)setReviewed(true);}}>
    <div className="cp-pills" aria-label="Decision type">{([{id:'choice',name:'Choice'},{id:'score',name:'Score'},{id:'noul',name:'Proposition'}] as const).map(item=><button type="button" key={item.id} aria-pressed={fields.kind===item.id} onClick={()=>change('kind',item.id)}>{item.name}</button>)}</div>
    <label>{fields.kind==='noul'?'Proposition to evaluate':'The question'}<input value={fields.question} onChange={event=>change('question',event.target.value)} maxLength={400} placeholder="What do you need to decide?" required/></label>
    <label>Input and evidence<textarea value={fields.input} onChange={event=>change('input',event.target.value)} maxLength={6000} placeholder="Add the facts and source material." required/></label>
    {fields.kind==='choice'&&<label>Options<span className="cp-label-note">One per line, up to 30. Include a review option where needed.</span><textarea className="cp-options-input" value={fields.options.join('\n')} onChange={event=>change('options',event.target.value.split('\n'))} maxLength={1000} required/></label>}
    <label>{fields.kind==='score'?'Scoring rubric and range':'Criteria and review conditions'}<textarea className="cp-short-input" value={fields.criteria} onChange={event=>change('criteria',event.target.value)} maxLength={2000} placeholder="What matters most?" required/></label>
    <button type="submit" className="cp-button cp-button--red" disabled={!ready}>Review worksheet</button>
   </form>
   <aside className="cp-decision-output"><div className="cp-paper-heading"><ShieldCheck size={20}/><h2>Review</h2></div>
    {reviewed?<div className="cp-decision-result"><h3>{fields.question}</h3><p>{fields.input}</p>{fields.kind==='choice'&&<ol>{fields.options.filter(option=>option.trim()).map((option,index)=><li key={`${index}-${option}`}>{option}</li>)}</ol>}<h4>What matters</h4><p>{fields.criteria}</p><p>This is your worksheet. No model has evaluated it.</p><button type="button" className="cp-button cp-button--ink" onClick={download}>Download worksheet</button></div>:<div className="cp-empty"><h2>Start with the question</h2><p>Complete the worksheet to review the evidence and options together.</p></div>}
   </aside>
  </div>
 </section>;
}
