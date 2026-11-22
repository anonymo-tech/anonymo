'use client';

// Update "pricetag": next to the composer, the estimated price of the message being written, what this chat has been
// charged so far (from receipts), and an optional per-chat limit kept on this device. Math in lib/anonymo/pricetag.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import {
  chatSpend, checkLimit, estimateMessage, parseLimit, priceLabel, spentLabel, usdText,
  type ChargedTurn, type ChatSpend, type Estimate, type LimitCheck, type PricedModel,
} from '@/lib/anonymo/pricetag';
import { limitsStore, setChatLimit } from '@/lib/anonymo/pricetag-store';
import type { ChatMessage, MicroUsd } from '@/lib/anonymo/types';

export type PriceTagState = {
  on: boolean;
  demo: boolean;
  chatId: string;
  model: string;
  /** Null while the draft is empty. */
  estimate: Estimate | null;
  spend: ChatSpend;
  limit: MicroUsd | null;
  check: LimitCheck;
  /** Sending is blocked by this chat's limit. */
  blocked: boolean;
};

export function usePriceTag({ on, demo, chatId, model, priced, messages, turns, extraUsd }: {
  on: boolean;
  demo: boolean;
  chatId: string;
  model: string;
  /** The selected model's /v1/models entry, if listed. */
  priced: PricedModel | null;
  /** What will be sent with the current draft (whole thread, character prompt, draft), or null while it is empty. */
  messages: ChatMessage[] | null;
  turns: readonly ChargedTurn[];
  /** A flat price added to the next call (the web search price when search is on). */
  extraUsd?: string;
}): PriceTagState {
  const limits = useDeviceStore(limitsStore(demo));
  const limit = on ? (limits[chatId] ?? null) : null;
  const estimate = useMemo(() => (on && messages ? estimateMessage({ model: priced, messages, demo, extraUsd }) : null), [on, messages, priced, demo, extraUsd]);
  const spend = useMemo(() => chatSpend(turns), [turns]);
  const check: LimitCheck = on && estimate ? checkLimit(limit, spend, estimate) : { blocked: false };
  return { on, demo, chatId, model, estimate, spend, limit, check, blocked: check.blocked };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function PriceTag({ demo, chatId, model, estimate, spend, limit, check }: PriceTagState) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  function edit() {
    setDraft(limit === null ? '' : usdText(limit).slice(1).replace(/,/g, ''));
    setNote('');
    setEditing(true);
  }
  function save() {
    const musd = parseLimit(draft);
    if (musd === null) {
      setNote('Enter an amount, like 0.50.');
      return;
    }
    setNote(setChatLimit(demo, chatId, musd) ? '' : 'This browser would not save it, so the limit lasts until you leave this page.');
    setEditing(false);
  }
  function remove() {
    setChatLimit(demo, chatId, null);
    setNote('');
    setEditing(false);
  }

  const council = model === 'anonymo-council' && !demo;
  const notes = [
    spend.refused ? `${plural(spend.refused, 'refused reply', 'refused replies')} billed $0` : '',
    spend.pending ? `checking ${plural(spend.pending, 'receipt', 'receipts')}` : '',
    spend.unknown ? `${plural(spend.unknown, 'stopped reply', 'stopped replies')} not counted` : '',
  ].filter(Boolean);

  return (
    <>
      <div className="price-tag" style={{ order: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 14px', fontSize: 12.5, color: 'var(--muted)' }}>
        {estimate && (estimate.known ? (
          <span
            aria-live="polite"
            title={`Estimate from this model's list price. About ${estimate.tokensIn.toLocaleString('en-US')} tokens go in, because the whole chat is sent each time, and a typical reply is about ${estimate.typicalOut.toLocaleString('en-US')} tokens. "Up to" assumes the longest reply allowed (${estimate.worstOut.toLocaleString('en-US')} tokens).${council ? ' The council makes four or five paid calls, so this is a rough range.' : ''}`}
          >
            Estimate: about <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{priceLabel(estimate.typical, 'nearest')}</strong> for this message
            {priceLabel(estimate.worst, 'up') !== priceLabel(estimate.typical, 'nearest') && <>, up to {priceLabel(estimate.worst, 'up')}</>}
          </span>
        ) : (
          <span aria-live="polite">This model&rsquo;s price isn&rsquo;t known, so there&rsquo;s no estimate.</span>
        ))}
        <span title="What the receipts for this chat's replies charged. A refused reply is billed $0.">
          This chat so far: <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{spentLabel(spend.charged)}</strong>
          {notes.length > 0 && <> ({notes.join(', ')})</>}
        </span>
        {editing ? (
          <form
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label htmlFor="price-tag-limit">Stop this chat at $</label>
            <input
              id="price-tag-limit"
              ref={field}
              className="input"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.50"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ width: 84, minHeight: 0, height: 30, padding: '0 8px', fontSize: 13 }}
            />
            <button type="submit" className="btn btn-small">Save</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        ) : limit === null ? (
          <button type="button" className="btn btn-small btn-ghost" title="Kept on this device only." onClick={edit}>Set a chat limit</button>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span title="Kept on this device only.">Stops at {usdText(limit)}</span>
            <button type="button" className="btn btn-small btn-ghost" onClick={edit}>Change</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={remove}>Remove</button>
          </span>
        )}
        {note && <output>{note}</output>}
      </div>
      {check.blocked && (
        <div className="notice notice-amber row" role="alert" style={{ order: 1 }}>
          <span style={{ flex: 1, minWidth: 200 }}>
            {check.reason === 'over'
              ? `Sending this could take this chat past its ${usdText(check.limit)} limit: ${spentLabel(check.spent)} spent so far, and this message could cost up to ${priceLabel(check.worst, 'up')}. Raise or remove the limit to send.`
              : `This model’s price isn’t known, so the ${usdText(check.limit)} limit can’t be checked. Choose a model with a listed price, or remove the limit.`}
          </span>
          <button type="button" className="btn btn-small" onClick={edit}>Raise limit</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={remove}>Remove limit</button>
        </div>
      )}
    </>
  );
}
