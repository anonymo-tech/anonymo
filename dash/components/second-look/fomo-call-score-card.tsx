"use client";
import { ArrowUpRight, Check, Clock3, FileSearch, TrendingDown } from 'lucide-react';
import type { FomoAnalysis } from '../../lib/second-look/fomo';
import { publicCallStudy } from '../../lib/second-look/fomo-call-study';
const pct=(n:number|null)=>n===null?'—':`${n>0?'+':''}${(n*100).toFixed(1)}%`;
const when=(s:string)=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC',hour12:false}).format(new Date(s));

export function FomoCallScoreCard({report,compact=false,onSources}:{report:FomoAnalysis;compact?:boolean;onSources?:(id?:string)=>void}){
  const study=publicCallStudy(report);
  if(!study)return null;
  return <section className="fomo-call-study" aria-label="Public call score and reasons">
    <div className="fomo-call-score-top">
      <div className="fomo-call-score-number"><strong>{study.score??'—'}</strong><span>/100</span></div>
      <div><h3>{study.label}</h3><p>{study.measured} measured calls · {study.assets} assets · 24-hour long scenario</p><small>Limited sample · {study.outcomes.length} of {study.published30d??'unknown'} calls displayed from the last 30 days</small></div>
    </div>
    {study.score!==null && <p className="fomo-call-verdict">{study.reasons[0]} {study.reasons[1]}</p>}
    {compact ? <button className="fomo-research-source-button" onClick={()=>onSources?.()}><FileSearch size={15}/> See exactly why <ArrowUpRight size={15}/></button> : <>
      <div className="fomo-call-factors">{study.factors.map(f=><article key={f.id}><header><strong>{f.label}</strong><span>{f.contribution.toFixed(1)} / {f.weight} pts</span></header><div className="fomo-factor-track"><i style={{width:`${f.score}%`}}/></div><p>{f.reason}</p></article>)}</div>
      <div className="fomo-call-record-head"><h4>The calls we measured</h4><span>1% total-cost scenario</span></div>
      <div className="fomo-call-outcomes">{study.outcomes.map(o=><details key={o.call.id}>
        <summary><div className="fomo-call-token"><span>{o.call.token.symbol.replace(/^\$/,'')}</span><small>{when(o.call.createdAt)} UTC</small></div><div className="fomo-call-result"><strong className={o.scenarioReturn!==null && o.scenarioReturn<0?'is-negative':''}>{o.status==='pending'?<><Clock3 size={13}/> Measuring</>:o.status==='unavailable'?'Not scored':pct(o.scenarioReturn)}</strong><small>{o.status==='measured'?`Worst dip ${pct(-(o.adverseMove??0))}`:o.status==='pending'?'Window still open':'Inspect reason'}</small></div></summary>
        <div className="fomo-call-detail"><p>{o.reason}</p><dl><div><dt>Publication</dt><dd>{when(o.call.createdAt)} UTC</dd></div><div><dt>Entry mark</dt><dd>{when(o.entryAt)} UTC {o.entryUsd!==null?`· $${o.entryUsd.toPrecision(5)}`:''}</dd></div><div><dt>Exit mark</dt><dd>{when(o.exitAt)} UTC {o.exitUsd!==null?`· $${o.exitUsd.toPrecision(5)}`:''}</dd></div><div><dt>Before cost scenario</dt><dd>{pct(o.grossReturn)}</dd></div><div><dt>Intervals with trades</dt><dd>{o.activeShare===null?'—':`${Math.round(o.activeShare*100)}%`}</dd></div></dl><div className="fomo-research-citations">{o.sourceIds.map(id=><button key={id} onClick={()=>onSources?.(id)}><FileSearch size={12}/>{id}</button>)}</div></div>
      </details>)}</div>
      <div className="fomo-call-checks"><span><Check size={14}/> Exact token & publication time</span><span><Check size={14}/> Repeated tokens share weight</span><span><TrendingDown size={14}/> Adverse moves included</span></div>
      <details className="fomo-research-formula"><summary>How this number is calculated</summary><p>Every call uses the same hypothetical long exposure: enter at the next five-minute boundary at least five minutes after publication, exit exactly 24 hours later. This does not assume the author recommended a 24-hour trade or actually bought and sold at those times. We use historical pool price marks, check endpoint freshness and reject gaps or conflicting venues. These marks are not guaranteed executable prices.</p><p>Calls are averaged within each token, then tokens receive equal weight. Outcome: clamp(50 + 100 × scenario return), worth 40 points. Downside: clamp(100 × (1 − adverse move / 50%)), worth 25. Positive outcomes: asset-balanced proportion, worth 20. Activity: observed trading intervals / 50%, capped at 100%, worth 15. Each asset's outcome, downside and activity component is clamped before averaging; clamp means a floor of 0 and ceiling of 100.</p><p>The default scenario deducts 1% from the gross ending value for total costs. Actual fees and slippage may differ. {study.costRange?`At 0–2% total costs, the score ranges from ${study.costRange[0]} to ${study.costRange[1]}. This is sensitivity, not a statistical confidence interval.`:''}</p><p>{study.scope} Current pool selection and incomplete call coverage can bias this sample. The weights are a published descriptive rubric, not a validated prediction. Method {study.version}.</p></details>
    </>}
  </section>;
}
