export type QuickPhrase={shortcut:string;text:string};
export const isQuickPhrases=(value:unknown):value is QuickPhrase[]=>Array.isArray(value)&&value.length<=50&&new Set(value.map(p=>p?.shortcut)).size===value.length&&value.every(p=>p&&typeof p==='object'&&typeof p.shortcut==='string'&&/^[a-z][a-z0-9-]{0,29}$/.test(p.shortcut)&&typeof p.text==='string'&&p.text.trim().length>0&&p.text.length<=10000);
export function expandPhrase(draft:string,phrase:QuickPhrase){return draft.replace(new RegExp(`/${phrase.shortcut}$`),()=>phrase.text);}
