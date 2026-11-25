'use client';

import { MessagesSquare, ReceiptText, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { answerSections, ASK_TOPICS, type AskMoReply, type AskMoRequest, type AskTopic } from '@/lib/anonymo/askmo';
import { AnonymoApiError } from '@/lib/anonymo/client';
import { formatUsdAmount } from '@/lib/anonymo/money';
import { setupHref } from '@/lib/anonymo/setup-return';
import { useAnonymo } from '../anonymo-provider';
import { WebSources } from './web-sources';
import './ask-mo.css';

const PAGE = '/dashboard/ask';
const TOPICS = Object.entries(ASK_TOPICS) as [AskTopic, string][];

export function AskMo() {
  const { key, client, rememberReceipt, refreshBalance } = useAnonymo();
  const [draft, setDraft] = useState('');
  const [topic, setTopic] = useState<AskTopic | null>(null);
  const [answer, setAnswer] = useState<{ request: AskMoRequest; reply: AskMoReply } | null>(null);
  const [opinion, setOpinion] = useState<AskMoReply | null>(null);
  const [busy, setBusy] = useState<'ask' | 'opinion' | null>(null);
  const [error, setError] = useState<{ message: string; funds: boolean } | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    setAnswer(null);
    setOpinion(null);
    setBusy(null);
    setError(null);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [client]);

  async function send(request: AskMoRequest, second: boolean) {
    if (!key || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(second ? 'opinion' : 'ask');
    setError(null);
    if (!second) setAnswer(null);
    setOpinion(null);
    try {
      const reply = await (second ? client.secondOpinion(request, controller.signal) : client.askMo(request, controller.signal));
      if (controller.signal.aborted) return;
      if (reply.receiptId) rememberReceipt({ id: reply.receiptId, model: reply.model, at: new Date().toISOString() });
      if (second) setOpinion(reply);
      else setAnswer({ request, reply });
    } catch (e) {
      if (!controller.signal.aborted) setError({
        message: e instanceof AnonymoApiError ? e.message : 'Could not reach the gateway. Try again.',
        funds: e instanceof AnonymoApiError && e.code === 'insufficient_balance',
      });
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(null);
        refreshBalance();
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (question) void send({ question, topic }, false);
  }

  return (
    <div className="ask-mo">
      <form className="card ask-mo-form" onSubmit={submit}>
        <fieldset className="ask-mo-topics">
          <legend>Topic</legend>
          {([[null, 'Any topic'], ...TOPICS] as [AskTopic | null, string][]).map(([id, label]) => (
            <button className="btn btn-small" type="button" aria-pressed={topic === id} key={id ?? 'any'} onClick={() => setTopic(id)}>
              {label}
            </button>
          ))}
        </fieldset>
        <label htmlFor="ask-mo-question">Your question</label>
        <textarea id="ask-mo-question" className="textarea" placeholder="What would you like to know?" rows={4} maxLength={4000}
          value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
        <div className="ask-mo-actions">
          <p className="faint">A web search provider receives the search terms. Leave out personal details.</p>
          {key ? (
            <button type="submit" className="btn btn-primary" disabled={!!busy || !draft.trim()}>
              <Search size={16} aria-hidden="true" /> {busy === 'ask' ? 'Searching…' : 'Ask Mo'}
            </button>
          ) : (
            <Link className="btn btn-primary" href={setupHref('key', PAGE)}>Set up an API key</Link>
          )}
        </div>
      </form>
      <div className="sr-only" role="status">{busy === 'ask' ? 'Searching and checking the answer' : busy === 'opinion' ? 'Asking three model families' : answer ? 'Answer ready' : ''}</div>
      {answer && (
        <section className="card ask-mo-answer" aria-label="Ask Mo answer">
          <header>
            <h2>Answer</h2>
            {answer.request.topic && <span className="chip chip-amber">{ASK_TOPICS[answer.request.topic]}</span>}
          </header>
          <p className="muted ask-mo-question">{answer.request.question}</p>
          {answerSections(answer.reply.text).map(({ heading, body }, i) => (
            <div className="answer-body" key={i}>
              {heading && <h3>{heading}</h3>}
              <p>{body}</p>
            </div>
          ))}
          {!answer.reply.text && <p className="muted">Mo couldn’t give a cited answer. Try narrowing your question.</p>}
          <WebSources citations={answer.reply.sources} />
          <div className="ask-mo-actions">
            <ReceiptLink reply={answer.reply} />
            {!answer.reply.receipt?.refused && (
              <button type="button" className="btn" disabled={!!busy || !!opinion?.council?.comparison} onClick={() => void send(answer.request, true)}>
                <MessagesSquare size={16} aria-hidden="true" /> {busy === 'opinion' ? 'Comparing…' : 'Second Opinion'}
              </button>
            )}
          </div>
        </section>
      )}
      {error && (
        <div className="notice notice-rose row" role="alert">
          <span>{error.message}</span>
          {error.funds && <Link className="btn btn-small" href={setupHref('funds', PAGE)}>Add funds</Link>}
        </div>
      )}
      {opinion && <SecondOpinion reply={opinion} />}
    </div>
  );
}

function ReceiptLink({ reply }: { reply: AskMoReply }) {
  if (!reply.receiptId) return null;
  return (
    <Link className="ask-mo-receipt" href={`/dashboard/receipts/${encodeURIComponent(reply.receiptId)}`}>
      <ReceiptText size={15} aria-hidden="true" /> Receipt {reply.receipt && <span className="mono">{formatUsdAmount(reply.receipt.cost)}</span>}
    </Link>
  );
}

function SecondOpinion({ reply }: { reply: AskMoReply }) {
  const { council } = reply;
  return (
    <section className="card" aria-label="Second Opinion">
      <header><h2>Second Opinion</h2><ReceiptLink reply={reply} /></header>
      {council && (
        <ul className="ask-mo-families" aria-label="Model families">
          {council.proposers.map((p) => (
            <li key={p.label}>{p.label} · {p.family}{p.status !== 'ok' && ` · ${p.status}`}</li>
          ))}
        </ul>
      )}
      {council?.comparison ? (
        <div className="ask-mo-comparison">
          <div><h3>Where they agree</h3><p>{council.comparison.agree}</p></div>
          <div><h3>Where they disagree</h3><p>{council.comparison.disagree}</p></div>
        </div>
      ) : <p className="muted">The council judge didn’t return a comparison. You can try again.</p>}
    </section>
  );
}
