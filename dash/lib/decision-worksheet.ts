export type DecisionKind = 'choice' | 'score' | 'noul';
export type DecisionFields = {kind:DecisionKind;question:string;input:string;criteria:string;options:string[]};
export type DecisionDraft = DecisionFields & {version:1;id:string;title:string;updatedAt:number};
export const EMPTY_DECISION_DRAFTS:DecisionDraft[]=[];
export const EMPTY_DECISION:DecisionFields={kind:'choice',question:'',input:'',criteria:'',options:['Billing','Account','Technical','Other / review']};
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function text(value:unknown,max:number):value is string{return typeof value==='string'&&value.length<=max&&!value.includes('\0');}
export function isDecisionFields(value:unknown):value is DecisionFields {
 if(!record(value))return false;
 return ['choice','score','noul'].includes(String(value.kind))&&text(value.question,400)&&text(value.input,6000)&&text(value.criteria,2000)&&Array.isArray(value.options)&&value.options.length<=30&&value.options.every(option=>text(option,1000))&&value.options.join('\n').length<=1000;
}
export function decisionReady(value:DecisionFields){return isDecisionFields(value)&&!!(value.question.trim()&&value.input.trim()&&value.criteria.trim()&&(value.kind!=='choice'||value.options.filter(option=>option.trim()).length>=2));}
export function isDecisionDrafts(value:unknown):value is DecisionDraft[]{
 return Array.isArray(value)&&value.length<=20&&new Set(value.map(item=>record(item)?item.id:null)).size===value.length&&value.every(item=>record(item)&&item.version===1&&typeof item.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)&&text(item.title,80)&&item.title.trim().length>0&&Number.isSafeInteger(item.updatedAt)&&Number(item.updatedAt)>0&&isDecisionFields(item));
}
export function saveDecisionDraft(drafts:DecisionDraft[],draft:DecisionDraft):DecisionDraft[]{
 const next=[draft,...drafts.filter(item=>item.id!==draft.id)];
 const tooMany=next.length>20;
 if(!isDecisionDrafts(next))throw new Error(tooMany?'You have 20 saved worksheets. Delete one before saving another.':'Check the worksheet fields before saving.');
 return next;
}
export function decisionDownload(value:DecisionFields){return JSON.stringify({kind:value.kind,question:value.question.trim(),input:value.input.trim(),criteria:value.criteria.trim(),...(value.kind==='choice'?{options:value.options.map(option=>option.trim()).filter(Boolean)}:{}),result:null,requiresReview:true,status:'not_evaluated'},null,2);}

export const DECISION_IMPORT_MAX_BYTES=100_000;
/** Import only worksheet fields. Files cannot supply a model result or a reviewed state. */
export function parseDecisionImport(source:string):DecisionFields {
 if(new TextEncoder().encode(source).byteLength>DECISION_IMPORT_MAX_BYTES)throw new Error('Choose a JSON worksheet smaller than 100 KB.');
 let value:unknown;
 try{value=JSON.parse(source);}catch{throw new Error('This file is not valid JSON. Choose a downloaded decision worksheet.');}
 if(!record(value)||Object.keys(value).some(key=>!['kind','question','input','criteria','options','result','requiresReview','status'].includes(key)))throw new Error('This file does not match a Conclave decision worksheet.');
 const fields={kind:value.kind,question:value.question,input:value.input,criteria:value.criteria,options:value.options??[]};
 if(!isDecisionFields(fields))throw new Error('Check the worksheet type and field limits: question 400, evidence 6,000, criteria 2,000 characters and up to 30 options.');
 return {kind:fields.kind,question:fields.question,input:fields.input,criteria:fields.criteria,options:[...fields.options]};
}
