"use client";
import { Activity, ArrowUpRight, Check, CircleHelp, Clock3, FileSearch, ShieldCheck, TriangleAlert } from 'lucide-react';
import { FomoCallScoreCard } from './fomo-call-score-card';
import { publicCallStudy } from '../../lib/second-look/fomo-call-study';
import type { FomoAnalysis } from '../../lib/second-look/fomo';
import { researchFomoEvidence } from '../../lib/second-look/fomo-research';
import './fomo-research-card.css';

export function FomoResearchCard({ report, compact=false, onSources }: {
  report: FomoAnalysis; compact?: boolean; onSources?: (id?: string) => void;
}) {
  const r = researchFomoEvidence(report);
  const study = publicCallStudy(report);
  return <section className={`fomo-research-card${compact ? ' is-compact' : ''}`} aria-label="Research methodology and verification">
    <header>
      <div><ShieldCheck size={22}/><h2>Research & results</h2></div>
      <span>{r.observedChecks}/{r.totalChecks} checks have observations</span>
    </header>
    {study && <FomoCallScoreCard report={report} compact={compact} onSources={onSources}/>}
    {!study && <div className="fomo-research-summary">
      <div className="fomo-research-grade"><span aria-label="Not yet scored">—</span><div><strong>Performance score</strong><p>Needs reconciled history</p></div></div>
      <p>We can inspect the public record. A fair grade also needs verified trades, risk and callout outcomes.</p>
    </div>}
    {compact ? (!study && <button className="fomo-research-source-button" onClick={() => onSources?.()}><FileSearch size={15}/> Inspect all {r.totalChecks} research checks <ArrowUpRight size={15}/></button>) : <>
      <details className="fomo-all-checks" open={!study}><summary>All {r.totalChecks} research checks · {r.observedChecks} with evidence</summary><div className="fomo-research-checks">
        {r.checks.map(c => {
          const Icon = c.status==='checked' ? ShieldCheck : c.status==='observed' ? Check : c.status==='conflict' ? TriangleAlert : c.status==='stale' ? Clock3 : CircleHelp;
          return <details key={c.id} className={`fomo-research-check is-${c.status}`}>
            <summary><Icon size={17}/><strong>{c.label}</strong><span>{c.status==='checked' ? 'Chain checked' : c.status==='observed' ? 'Source observed' : c.status==='unknown' ? 'Not verified' : c.status==='stale' ? 'Date needs review' : 'Conflicting data'}</span></summary>
            <p>{c.detail}</p>
            {c.id==='token-controls' && report.sources.filter(s=>s.id.startsWith('chain-') && s.data?.method==='finalized-mint-bytes').map(s=>
              <dl className="fomo-research-chain-facts" key={s.id}>
                {Array.isArray(s.data?.checks) && s.data.checks.flatMap((check: {id?:number;facts?:{key:string;label:string;value:unknown}[]})=>check.id===1 && Array.isArray(check.facts) ? check.facts.filter(f=>['mintAuthority','freezeAuthority'].includes(f.key)).map(f=><div key={f.key}><dt>{f.label}</dt><dd>{f.value===null ? 'None at checked slot' : typeof f.value==='string' ? f.value : 'Unknown'}</dd></div>) : [])}
              </dl>)}
            {c.sourceIds.length>0 && <div className="fomo-research-citations">{c.sourceIds.map(id => {
              const source=report.sources.find(s=>s.id===id);
              return source ? <button key={id} onClick={() => onSources?.(id)} title={source.label}><FileSearch size={12}/>{id}</button> : null;
            })}</div>}
          </details>;
        })}
      </div></details>
      <details className="fomo-research-formula">
        <summary><Activity size={17}/> Account-wide performance method</summary>
        <p>This separate account-wide grade requires reconciled records. It is not the public-call score above. Four models examine the evidence and challenge its interpretation. Neither follower count nor model agreement adds points.</p>
        <div>{r.factors.map(f=><article key={f.id}><header><strong>{f.label}</strong><b>{f.weight}%</b></header><div className="fomo-factor-track"><i style={{width:`${f.weight}%`}}/></div><p>{f.requirement}</p></article>)}</div>
        <p>The initial weights are a research policy, not a validated prediction. Every required factor needs evidence; missing factors are not filled with zero or redistributed. Method {r.version}.</p>
      </details>
      <footer><FileSearch size={15}/><span>Observations show coverage, not independent verification. Multiple FOMO indexes may repeat the same upstream record.</span></footer>
    </>}
  </section>;
}
