'use client';
import {useEffect,useRef,useState} from 'react';
import {createWorkspaceClient,workspaceErrorMessage,type ServiceProject} from '../../lib/client/workspace';

export function ArchivedProjects({accountId,onRestore,onOpen}:{accountId:string;onRestore:(id:string,revision:number)=>Promise<boolean>;onOpen:(id:string)=>void}) {
 const [open,setOpen]=useState(false),[items,setItems]=useState<ServiceProject[]>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
 const controller=useRef<AbortController|null>(null);
 useEffect(()=>()=>controller.current?.abort(),[]);
 async function load(more=false){
  controller.current?.abort();const current=new AbortController();controller.current=current;
  setBusy(true);setError('');
  try{const result=await createWorkspaceClient({accountId,signal:current.signal}).archivedProjects(more?cursor:null);if(current.signal.aborted)return;setItems(previous=>more?[...previous,...result.items.filter(item=>!previous.some(old=>old.id===item.id))]:result.items);setCursor(result.nextCursor);setLoaded(true);}
  catch(cause){if(!current.signal.aborted)setError(workspaceErrorMessage(cause));}
  finally{if(!current.signal.aborted)setBusy(false);}
 }
 async function restore(item:ServiceProject){
  setBusy(true);setError('');
  try{if(await onRestore(item.id,item.revision)){setItems(previous=>previous.filter(project=>project.id!==item.id));onOpen(item.id);}else setError('The project could not be restored. Refresh the archive and try again.');}
  catch{setError('The project could not be restored. Refresh the archive and try again.');}
  finally{setBusy(false);}
 }
 return <div className="po-archive">
  <button type="button" className="cp-button" aria-expanded={open} aria-controls="po-archive-list" onClick={()=>{const next=!open;setOpen(next);if(next&&!loaded)void load();}}>Archived projects</button>
  {open&&<section id="po-archive-list" aria-label="Archived projects" aria-busy={busy}>
   <div className="po-archive-heading"><h2>Bring a project back</h2><button type="button" className="cp-text-button" disabled={busy} onClick={()=>void load()}>Refresh</button></div>
   {error&&<p role="alert">{error}</p>}
   {!busy&&loaded&&!items.length&&<p>No archived projects.</p>}
   {busy&&<output>Loading…</output>}
   <ul>{items.map(item=><li key={item.id}><span>{item.title}</span><button type="button" className="cp-button" disabled={busy} onClick={()=>void restore(item)}>Restore</button></li>)}</ul>
   {cursor&&<button type="button" className="cp-button" disabled={busy} onClick={()=>void load(true)}>Load older projects</button>}
  </section>}
 </div>;
}
