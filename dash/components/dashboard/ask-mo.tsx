'use client';

import { ArrowUpRight, BookOpen, ChevronDown, Compass, MessagesSquare, ReceiptText } from 'lucide-react';
import Link from 'next/link';
import { ASK_TOPICS, RESEARCH_CHAT, answerSections } from '@/lib/anonymo/askmo';
import { formatUsdAmount } from '@/lib/anonymo/money';
import { setupHref } from '@/lib/anonymo/setup-return';
import { hostOf, safeLink } from '@/lib/anonymo/search';
import type { Turn } from './chat-types';
import './ask-mo.css';

export function ResearchWelcome({ onPick }: { onPick: (question: string) => void }) {
  return <section className="empty chat-col research-welcome">
    <span className="research-mark"><Compass size={25} aria-hidden="true" /></span>
    <h1>What would you like to research?</h1>
    <p className="muted">Ask a question and explore the sources behind the answer.</p>
    <div className="starters">
      {['How do passkeys work across devices?', 'Compare proof of stake and proof of work.'].map(question =>
        <button key={question} type="button" onClick={() => onPick(question)}>{question} <ArrowUpRight size={14} aria-hidden="true" /></button>)}
    </div>
  </section>;
}

export function ResearchAnswer({ turn, onCompare }: { turn: Turn; onCompare?: () => void }) {
  const result = turn.research!;
  const opinion = result.kind === 'opinion';
  const sources = (result.sources ?? []).map((source, i) => ({ ...source, number: source.number ?? i + 1 }))
    .filter(source => safeLink(source.url));
  function citedText(text: string) {
    return text.split(/(\[[1-9]\d*\])/g).map((part, index) => {
      if (index % 2 === 0) return part;
      const source = sources.find(entry => entry.number === Number(part.slice(1, -1)));
      return source ? <a key={index} className="research-citation" href={source.url} target="_blank" rel="noopener noreferrer"
        title={source.title} aria-label={`Source ${source.number}, ${source.title}`}>{source.number}</a> : part;
    });
  }
  function paragraphs(body: string) {
    const blocks: { list: boolean; lines: string[] }[] = [];
    for (const line of body.split('\n')) {
      const item = /^\s*[-*]\s+(.+)$/.exec(line);
      const last = blocks.at(-1);
      if (item && last?.list) last.lines.push(item[1]);
      else blocks.push({ list: !!item, lines: [item ? item[1] : line] });
    }
    return blocks.map((block, i) => block.list
      ? <ul key={i}>{block.lines.map((line, j) => <li key={j}>{citedText(line)}</li>)}</ul>
      : block.lines[0].trim() && <p key={i}>{citedText(block.lines[0])}</p>);
  }
  return <section className="research-answer" aria-label={opinion ? 'Second opinion' : 'Research answer'}>
    <header className="reply-byline"><span className="research-mark">{opinion ? <MessagesSquare size={16} /> : <Compass size={16} />}</span>
      {opinion ? 'Second opinion' : 'Research'}{result.topic && <small>{ASK_TOPICS[result.topic]}</small>}
    </header>
    {turn.status === 'streaming' ? <p role="status">{opinion ? 'Comparing model answers…' : 'Searching the web…'}</p>
      : turn.status === 'stopped' ? <p role="status">Stopped.</p>
      : turn.status === 'error' ? <p className="notice notice-rose" role="alert">{turn.error} {turn.needsFunds && <Link href={setupHref('funds', RESEARCH_CHAT)}>Add funds</Link>}</p>
      : <>
        {result.comparison ? <>
          {result.families?.length ? <p className="muted">{result.families.join(' · ')}</p> : null}
          <div className="research-comparison">{(['agree', 'disagree'] as const).map(part =>
            <div key={part}><h3>Where they {part}</h3><p>{result.comparison![part]}</p></div>)}</div>
        </> : answerSections(turn.content || (opinion ? 'The models didn’t return a comparison.' : 'No cited answer came back. Try a narrower question.')).map((section, i) =>
          <div className="answer-body" key={i}>{section.heading && <h3>{section.heading}</h3>}{paragraphs(section.body)}</div>)}
        {sources.length > 0 && <details className="research-sources"><summary><BookOpen size={15} /> Sources <span>{sources.length}</span><ChevronDown size={14} aria-hidden="true" /></summary>
          <ol>{sources.map(source => <li key={source.number} value={source.number}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} <ArrowUpRight size={13} /></a><small>{hostOf(source.url)}</small></li>)}</ol>
        </details>}
        <footer>{onCompare && !opinion && !result.refused && <button type="button" onClick={onCompare}><MessagesSquare size={14} /> Get a second opinion</button>}
          {turn.receiptId && <Link href={'/dashboard/receipts/' + encodeURIComponent(turn.receiptId)}><ReceiptText size={14} /> Receipt {turn.receipt && formatUsdAmount(turn.receipt.cost)}</Link>}
        </footer>
      </>}
  </section>;
}
