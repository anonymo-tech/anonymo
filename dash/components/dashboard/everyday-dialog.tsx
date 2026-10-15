'use client';
import { useEffect, useRef, type ReactNode } from 'react';
export function EverydayDialog({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{ const dialog=ref.current; dialog?.showModal(); return()=>dialog?.close(); },[]);
  return <dialog ref={ref} className="eu-dialog" aria-label={title} onCancel={onClose} onClick={e=>{if(e.target===ref.current){const box=ref.current.getBoundingClientRect();if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)onClose();}}}><header><h2>{title}</h2><button type="button" aria-label={`Close ${title}`} onClick={onClose}>Close</button></header>{children}</dialog>;
}
