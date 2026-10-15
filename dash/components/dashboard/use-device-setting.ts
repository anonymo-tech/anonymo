'use client';
import {useCallback,useSyncExternalStore} from 'react';
type Snapshot={value:unknown;error:string};
const cache=new Map<string,Snapshot>(),listeners=new Map<string,Set<()=>void>>();
function notify(key:string){listeners.get(key)?.forEach(listener=>listener());}
/** Account-scoped device preferences; failed writes remain available for this session. */
export function useDeviceSetting<T>(key:string,initial:T,valid:(value:unknown)=>value is T,enabled=true){
 const getSnapshot=useCallback(()=>{
  if(!enabled)return null;
  if(!cache.has(key)){let value:unknown=initial,error='';try{const stored:unknown=JSON.parse(localStorage.getItem(key)??'null');if(valid(stored))value=stored;}catch{error='Device storage is unavailable. Changes last for this session.';}cache.set(key,{value,error});}
  return cache.get(key)!;
 },[key,valid,enabled,initial]);
 const subscribe=useCallback((listener:()=>void)=>{if(!enabled)return()=>{};const set=listeners.get(key)??new Set();listeners.set(key,set);set.add(listener);const changed=(event:StorageEvent)=>{if(event.key===key||event.key===null){cache.delete(key);notify(key);}};window.addEventListener('storage',changed);return()=>{set.delete(listener);window.removeEventListener('storage',changed);};},[key,enabled]);
 const snapshot=useSyncExternalStore(subscribe,getSnapshot,()=>null);
 function save(next:T){if(!enabled||!snapshot||!valid(next))return;let error='';try{localStorage.setItem(key,JSON.stringify(next));}catch{error='Device storage is unavailable. Changes last for this session.';}cache.set(key,{value:next,error});notify(key);}
 return {value:(snapshot?.value??initial) as T,save,loaded:!!snapshot,error:snapshot?.error??''};
}
export const isStringList=(value:unknown):value is string[]=>Array.isArray(value)&&value.length<=256&&value.every(item=>typeof item==='string'&&item.length<=160);
const subscribeClient=()=>()=>{};
export function useClientReady(){return useSyncExternalStore(subscribeClient,()=>true,()=>false);}
