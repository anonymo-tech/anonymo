'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { createWorkspaceClient } from '../../lib/client/workspace';
import {
  BLIND_RECORD_LIMITS,
  countBlindRecord,
  isSmallBlindSample,
  type BlindRecordProgress,
  type BlindRecordResult,
} from '../../lib/blind-record';
import { MODELS } from './data';
import './blind-record.css';

export function BlindRecord({ accountId }: { accountId?: string | null }) {
  const t = useT();
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [progress, setProgress] = useState<BlindRecordProgress | null>(null);
  const [result, setResult] = useState<BlindRecordResult | null>(null);
  const [notice, setNotice] = useState<'cancelled' | 'error' | null>(null);

  useLayoutEffect(() => {
    const changed = () => {
      operation.current?.abort();
      operation.current = null;
      setBusy(false);
      setInvalidated(true);
      setProgress(null);
      setResult(null);
      setNotice(null);
    };
    window.addEventListener('conclave:session-change', changed);
    return () => {
      operation.current?.abort();
      operation.current = null;
      window.removeEventListener('conclave:session-change', changed);
    };
  }, []);

  async function count() {
    if (!accountId || invalidated || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setResult(null);
    setProgress({ projects: 0, comparisons: 0, votes: 0 });
    setNotice(null);
    try {
      const client = createWorkspaceClient({ accountId, signal: controller.signal });
      const next = await countBlindRecord(client, controller.signal, setProgress);
      if (!controller.signal.aborted) setResult(next);
    } catch {
      if (!controller.signal.aborted) setNotice('error');
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
      }
    }
  }

  function cancel() {
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    setProgress(null);
    setNotice('cancelled');
  }

  return (
    <section className="ct-detail cb-record" aria-label={t('Your blind record')}>
      <h3>{t('Your blind record')}</h3>
      <p>{t('See which model families you picked with their names hidden.')}</p>
      <p>{t('Counted in your browser from your own comparisons.')}</p>
      {!accountId ? (
        <p>{t('This needs a signed-in account. Sign in from Account & wallet; preview comparisons are not counted.')}</p>
      ) : invalidated ? (
        <p>{t('Account changed. Reopen Settings before counting again.')}</p>
      ) : (
        <>
          <p>{t('Counting requests your saved projects and comparisons. Scans up to {pages} pages per project and {comparisons} comparisons in total.', {
            pages: BLIND_RECORD_LIMITS.pagesPerProject,
            comparisons: BLIND_RECORD_LIMITS.comparisons,
          })}</p>
          <button className="ct-button" type="button" disabled={busy} onClick={() => void count()}>
            {t('Count my blind picks')}
          </button>
          {busy && <button className="ct-button" type="button" onClick={cancel}>{t('Cancel counting')}</button>}
          <div aria-live="polite">
            {busy && progress && <p>{t('Checked {projects} projects, scanned {comparisons} comparisons; {votes} blind votes found.', progress)}</p>}
            {notice === 'cancelled' && <p>{t('Counting cancelled. No tally was kept.')}</p>}
            {notice === 'error' && <p>{t('Counting could not finish. No complete tally is available. Try again when your account is available.')}</p>}
            {result && (
              <>
                <p className="cb-numbers">{t('Total blind votes: {votes}', { votes: result.votes })}</p>
                <p className="cb-numbers">{t('Comparisons scanned: {count}', { count: result.scanned })}</p>
                {result.comparisonCapReached && <p>{t('Reached the limit of {count} comparisons. This tally may leave out more history.', { count: BLIND_RECORD_LIMITS.comparisons })}</p>}
                {result.pageCapReached && <p>{t('Reached the limit of {count} pages in at least one project. This tally leaves out more history from those projects.', { count: BLIND_RECORD_LIMITS.pagesPerProject })}</p>}
                {isSmallBlindSample(result.votes) && <p>{t('Only {n} votes so far. Too few to read much into.', { n: result.votes })}</p>}
                {result.unattributed > 0 && <p>{t('{count} votes have no model family available and could not be assigned to a family.', { count: result.unattributed })}</p>}
              </>
            )}
          </div>
          {result && result.rows.length > 0 && (
            <>
              <p>{t('Pick rate is picks divided by voted blind comparisons featuring that family. Each family appears at most once per comparison.')}</p>
              <ul className="cb-families">
                {result.rows.map(row => (
                  <li key={row.family}>
                    <strong>{MODELS.find(model => model.id === row.family)?.name ?? row.family}</strong>
                    <dl className="ct-facts">
                      <div><dt>{t('Times picked')}</dt><dd className="cb-numbers">{row.picked}</dd></div>
                      <div><dt>{t('Times appeared')}</dt><dd className="cb-numbers">{row.appeared}</dd></div>
                      <div><dt>{t('Pick rate')}</dt><dd className="cb-numbers">{t('{rate}%', { rate: (row.pickRate * 100).toFixed(1) })}</dd></div>
                    </dl>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
