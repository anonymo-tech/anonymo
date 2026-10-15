'use client';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ChevronRight,
  Search,
  SlidersHorizontal,
  ScanLine,
  CircleCheck,
  CircleAlert,
  Clock3,
  Layers3,
} from 'lucide-react';
import type {
  TokenCandidate,
  TokenQuote,
  TokenReport,
  TokenCheck,
  TokenCapability,
} from '../../lib/second-look/token';
import {
  quoteResponse,
  reportResponse,
  reportsResponse,
  resolutionResponse,
  tokenCapabilitiesResponse,
} from '../../lib/client/second-look-contracts';
import { shortAddress, usd6 } from '../../lib/client/second-look';
import {
  checkGroups,
  exampleTokenReport,
  factText,
  JUP_MINT,
  SOL_MINT,
  USDC_MINT,
  tokenIdentity,
  utcTime,
  verdictLabel,
} from './presentation';
import {
  Busy,
  CopyButton,
  ErrorNotice,
  EvidenceLink,
  Modal,
  TokenAvatar,
  useSecondLookApi,
  type PanelProps,
} from './shared';
import { LaunchReplay } from './launch-replay';

function CheckIcon({ check }: { check: TokenCheck }) {
  if (check.status !== 'complete') return <Clock3 size={15} />;
  if (check.risk === 'red' || check.risk === 'caution')
    return <CircleAlert size={15} />;
  return <CircleCheck size={15} />;
}
export function TokenPanel(props: PanelProps) {
  const { accountId, onComposer, controlRef, onSignIn, onDraft, onToast } =
    props;
  const api = useSecondLookApi(accountId);
  const { run } = api;
  const [capability, setCapability] = useState<TokenCapability | null>(null);
  useEffect(() => {
    if (!accountId) return;
    void run(async (request) => {
      const result = await request('second-look/capabilities', {
        validate: tokenCapabilitiesResponse,
      });
      setCapability(result.token);
    });
  }, [accountId, run]);
  const [report, setReport] = useState<TokenReport | null>(null);
  const [example, setExample] = useState(false);
  const [candidates, setCandidates] = useState<TokenCandidate[]>([]);
  const [quote, setQuote] = useState<TokenQuote | null>(null);
  const [approvalAttempted, setApprovalAttempted] = useState(false);
  const [group, setGroup] = useState<string>('overview');
  const [selected, setSelected] = useState<number | null>(null);
  const [reportId, setReportId] = useState('');
  const [recent, setRecent] = useState<TokenReport[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const polls = useRef({ id: '', count: 0 });
  const [pausedReportId, setPausedReportId] = useState<string | null>(null);
  async function loadRecent(cursor?: string) {
    await run(async (request) => {
      const result = await request('second-look/reports', {
        validate: reportsResponse,
        cursor,
      });
      setRecent((items) =>
        cursor ? [...items, ...result.reports] : result.reports,
      );
      setNextCursor(result.nextCursor);
      setHistoryLoaded(true);
    });
  }
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    onComposer({
      placeholder: 'Paste a token address, ticker or link…',
      label: 'Check token',
      busy: api.busy,
    });
  }, [onComposer, api.busy]);
  const requestQuote = async (
    mint: string,
    mode: 'standard' | 'deep' = 'standard',
  ) => {
    if (!accountId) {
      onSignIn();
      return;
    }
    if (
      capability?.configured === false ||
      (mode === 'deep' && capability?.deepConfigured === false)
    ) {
      api.setError(
        mode === 'deep'
          ? 'Deep Check is waiting for launch and claim sources.'
          : 'Token Check is not connected yet. Saved reports remain available.',
      );
      return;
    }
    await run(async (request) => {
      const result = await request('second-look/tokens/check', {
        body: { mint, mode, idempotencyKey: crypto.randomUUID() },
        validate: quoteResponse,
      });
      setCandidates([]);
      setApprovalAttempted(false);
      setQuote(result.quote);
    });
  };
  async function submit(input: string) {
    if (!accountId) {
      api.setError(
        'Sign in to check live Solana data. You can explore the example below.',
      );
      onSignIn();
      return;
    }
    if (capability?.configured === false) {
      api.setError(
        'Live Token Check is not connected yet. Saved reports remain available.',
      );
      return;
    }
    setQuote(null);
    setCandidates([]);
    await run(async (request) => {
      const resolved = await request('second-look/resolve', {
        body: { input: input.trim() },
        validate: resolutionResponse,
      });
      if (resolved.status === 'choose') {
        setCandidates(resolved.candidates);
        return;
      }
      if (resolved.status !== 'resolved' || !resolved.mint) {
        api.setError(
          resolved.status === 'unavailable'
            ? 'Token lookup is unavailable. Try the mint address.'
            : 'No token found. Try its full Solana mint address.',
        );
        return;
      }
      const result = await request('second-look/tokens/check', {
        body: {
          mint: resolved.mint,
          mode: 'standard',
          idempotencyKey: crypto.randomUUID(),
        },
        validate: quoteResponse,
      });
      setApprovalAttempted(false);
      setQuote(result.quote);
    });
  }
  useImperativeHandle(controlRef, () => ({ submit }));
  async function approve() {
    if (!quote) return;
    setApprovalAttempted(true);
    await run(async (request) => {
      const result = await request('second-look/tokens/check', {
        body: { quoteId: quote.id, approvedMaximumUsd6: quote.maximumUsd6 },
        validate: reportResponse,
      });
      setExample(false);
      setReport(result.report);
      setReportId(result.report.id);
      setQuote(null);
      setSelected(null);
      setGroup('overview');
    });
  }
  useEffect(() => {
    if (
      !report ||
      example ||
      report.state !== 'pending' ||
      !accountId ||
      api.busy ||
      quote ||
      candidates.length > 0
    )
      return;
    if (polls.current.id !== report.id)
      polls.current = { id: report.id, count: 0 };
    if (polls.current.count >= 20) return;
    const timer = setTimeout(() => {
      polls.current.count++;
      if (polls.current.count >= 20) setPausedReportId(report.id);
      void run(async (request) => {
        const result = await request(`second-look/reports/${report.id}`, {
          validate: reportResponse,
        });
        setReport(result.report);
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, [report, example, accountId, api.busy, quote, candidates.length, run]);
  async function refreshReport() {
    if (!report || example) return;
    polls.current = { id: report.id, count: 0 };
    setPausedReportId(null);
    await run(async (request) => {
      const result = await request(`second-look/reports/${report.id}`, {
        validate: reportResponse,
      });
      setReport(result.report);
    });
  }
  const showExample = () => {
    setReport(exampleTokenReport());
    setExample(true);
    setSelected(null);
    setGroup('overview');
    api.setError('');
  };
  const token = report ? tokenIdentity(report.mint) : null;
  const activeGroup =
    checkGroups.find((item) => item.id === group) ?? checkGroups[0];
  const checks =
    report?.checks.filter((check) =>
      (activeGroup.checks as readonly number[]).includes(check.id),
    ) ?? [];
  const detail = report?.checks.find((check) => check.id === selected) ?? null;
  const expired = report && !example && Date.parse(report.expiresAt) <= now;
  return (
    <section className="sl-token-panel" aria-label="Token Check">
      <ErrorNotice message={api.error} />
      {capability?.configured === false && (
        <p className="sl-notice">
          Live Token Check is not connected yet. You can still view saved
          reports and the illustrative example.
        </p>
      )}
      {api.busy && (
        <div className="sl-progress">
          <Busy />
        </div>
      )}
      {!report ? (
        <div className="sl-start">
          <div className="sl-start-copy">
            <span className="sl-eyebrow">TOKEN CHECK</span>
            <h2>
              A second look.
              <br />
              Before your next move.
            </h2>
            <p>
              See the controls, holders and liquidity behind a Solana token.
            </p>
            <div className="sl-start-actions">
              <button className="sl-button sl-primary" onClick={showExample}>
                Explore a report <ArrowUpRight size={15} />
              </button>
              <span>Illustrative example</span>
            </div>
          </div>
          <div className="sl-start-panel">
            <div className="sl-section-heading">
              <h3>One token. Thirteen checks.</h3>
              <span className="sl-muted">Solana</span>
            </div>
            <div className="sl-preview-line">
              <SlidersHorizontal size={16} />
              <span>Who can change the rules?</span>
              <small>Token controls</small>
            </div>
            <div className="sl-preview-line">
              <Layers3 size={16} />
              <span>Who holds the supply?</span>
              <small>Wallets & clusters</small>
            </div>
            <div className="sl-preview-line">
              <ScanLine size={16} />
              <span>Can you get back out?</span>
              <small>Sell test & depth</small>
            </div>
            <div className="sl-start-foot">Facts first. Sources attached.</div>
          </div>
          <div className="sl-quick-tokens">
            <span>Start with an address</span>
            {[JUP_MINT, SOL_MINT, USDC_MINT].map((mint) => (
              <button
                key={mint}
                onClick={() => {
                  onDraft(mint);
                  onToast(
                    'Address added to the bar. Choose Check token to continue.',
                  );
                }}
              >
                <TokenAvatar mint={mint} size={24} />
                <strong>{tokenIdentity(mint).symbol}</strong>
                <span>{shortAddress(mint)}</span>
                <ArrowUpRight size={13} />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          {example && (
            <div className="sl-example">
              <span>EXAMPLE REPORT</span>Illustrative values · not findings
              about Jupiter.
              <button
                onClick={() => {
                  setReport(null);
                  setExample(false);
                }}
              >
                Close example
              </button>
            </div>
          )}
          <div className="sl-token-heading">
            <TokenAvatar mint={report.mint} size={44} />
            <div>
              <h2>
                {token?.name}
                <span>{token?.symbol}</span>
              </h2>
              <div className="sl-address">
                <span>{shortAddress(report.mint)}</span>
                <CopyButton value={report.mint} onToast={onToast} />
                <span>Solana</span>
              </div>
            </div>
            <div className="sl-heading-actions">
              <span className="sl-muted">
                {example
                  ? 'Illustrative'
                  : `${report.cached ? 'Cached · ' : ''}${utcTime(report.updatedAt)} UTC`}
              </span>
              <button
                className="sl-button"
                disabled={api.busy || capability?.deepConfigured === false}
                onClick={() => void requestQuote(report.mint, 'deep')}
                title={
                  capability?.deepConfigured === false
                    ? 'Launch and claim sources are not connected yet'
                    : undefined
                }
              >
                <Search size={14} />
                Deep Check{' '}
                <span>
                  {capability?.deepConfigured === false
                    ? 'Unavailable'
                    : '$0.10 max'}
                </span>
              </button>
            </div>
          </div>
          {expired && (
            <p className="sl-notice">
              This report has expired.{' '}
              <button onClick={() => void requestQuote(report.mint)}>
                Run a fresh check
              </button>
            </p>
          )}
          {!example && report.state === 'pending' && (
            <p className="sl-notice">
              {report.billing.reconciliationPending
                ? 'This check is awaiting confirmation. Your approved amount remains reserved; refreshing does not start another paid check.'
                : pausedReportId === report.id
                  ? 'This check is taking longer. It is saved in Recent checks.'
                  : 'Gathering evidence. This report updates automatically.'}{' '}
              <button onClick={() => void refreshReport()} disabled={api.busy}>
                Refresh status
              </button>
            </p>
          )}
          <div className={`sl-verdict sl-verdict-${report.verdict}`}>
            <span className="sl-status-dot" />
            <div>
              <strong>{verdictLabel[report.verdict]}</strong>
              <p>
                {report.reasons.slice(0, 3).join(' ') ||
                  'Open each check to review the available evidence.'}
              </p>
            </div>
            <span>
              {report.checks.filter((c) => c.status === 'complete').length}/13
              complete
            </span>
          </div>
          <nav className="sl-subnav" aria-label="Token report sections">
            {checkGroups.map((item) => (
              <button
                key={item.id}
                aria-current={group === item.id ? 'page' : undefined}
                onClick={() => {
                  setGroup(item.id);
                  setSelected(null);
                }}
              >
                {item.label}
                {item.id === 'claims' && <span>Deep</span>}
              </button>
            ))}
          </nav>
          <div className={`sl-report-body${detail ? ' has-detail' : ''}`}>
            <div>
              {group === 'claims' ? (
                <div className="sl-claims">
                  <div className="sl-section-heading">
                    <h3>Claims, checked against evidence</h3>
                    <span>Concur</span>
                  </div>
                  {!report.deep ? (
                    <div className="sl-inline-empty">
                      <p>
                        A Deep Check reviews project claims and the first 100
                        launch slots.
                      </p>
                      <button
                        className="sl-button"
                        onClick={() => void requestQuote(report.mint, 'deep')}
                        disabled={
                          api.busy || capability?.deepConfigured === false
                        }
                      >
                        Review Deep Check
                      </button>
                    </div>
                  ) : (
                    <>
                      {report.deep.claims.map((claim, i) => (
                        <article key={i} className="sl-claim">
                          <span className="sl-label">
                            {claim.outcome.replaceAll('_', ' ')}
                          </span>
                          <h4>{claim.claim}</h4>
                          {claim.evidence.map((e, j) => (
                            <p key={j}>
                              <q>{e.quote}</q>{' '}
                              <EvidenceLink href={e.url}>Source</EvidenceLink>
                            </p>
                          ))}
                        </article>
                      ))}
                      {report.deep.limitations.map((line, i) => (
                        <p className="sl-muted" key={i}>
                          {line}
                        </p>
                      ))}
                    </>
                  )}
                </div>
              ) : (
                <div className="sl-check-list">
                  <div className="sl-list-head">
                    <span>
                      {activeGroup.label === 'Overview'
                        ? 'Key checks'
                        : activeGroup.label}
                    </span>
                    <span>Finding</span>
                    <span>Status</span>
                  </div>
                  {checks.map((check) => (
                    <button
                      key={check.id}
                      className={`sl-check-row ${selected === check.id ? 'is-selected' : ''}`}
                      onClick={() =>
                        setSelected(selected === check.id ? null : check.id)
                      }
                      aria-expanded={selected === check.id}
                    >
                      <span className={`sl-check-name sl-risk-${check.risk}`}>
                        <CheckIcon check={check} />
                        <strong>{check.label}</strong>
                      </span>
                      <span className="sl-check-fact">
                        {check.facts[0] ? (
                          <>
                            {check.facts[0].label}
                            <b>{factText(check.facts[0].value)}</b>
                          </>
                        ) : (
                          'No verified data'
                        )}
                      </span>
                      <span className={`sl-check-status sl-risk-${check.risk}`}>
                        {check.status === 'complete'
                          ? check.risk === 'red'
                            ? 'Red flag'
                            : check.risk === 'caution'
                              ? 'Review'
                              : 'Checked'
                          : check.status === 'pending'
                            ? 'Checking'
                            : 'Unavailable'}
                        <ChevronRight size={14} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {group === 'launch' && report.deep?.launch && (
                <LaunchReplay key={report.id} launch={report.deep.launch} />
              )}
            </div>
            {detail && (
              <aside className="sl-detail">
                <div className="sl-section-heading">
                  <h3>{detail.label}</h3>
                  <button
                    className="sl-text-button"
                    onClick={() => setSelected(null)}
                  >
                    Close
                  </button>
                </div>
                <dl>
                  {detail.facts.map((fact) => (
                    <div key={fact.key}>
                      <dt>{fact.label}</dt>
                      <dd>{factText(fact.value)}</dd>
                    </div>
                  ))}
                </dl>
                {detail.limitations.map((line, i) => (
                  <p key={i} className="sl-muted">
                    {line}
                  </p>
                ))}
                <h4>Evidence</h4>
                {detail.sources.length ? (
                  detail.sources.map((source, i) => (
                    <div className="sl-source" key={i}>
                      <EvidenceLink href={source.reference}>
                        {source.provider}
                      </EvidenceLink>
                      <small>{utcTime(source.observedAt)} UTC</small>
                      {source.slot && <small>Slot {source.slot}</small>}
                      <small>
                        {Date.parse(source.expiresAt) <= now
                          ? 'Expired'
                          : `Expires ${utcTime(source.expiresAt)} UTC`}
                      </small>
                    </div>
                  ))
                ) : (
                  <p className="sl-muted">
                    {example
                      ? 'No live sources in this example.'
                      : 'No verified source available.'}
                  </p>
                )}
              </aside>
            )}
          </div>
          <footer className="sl-report-footer">
            <span>
              {report.ruleset} ·{' '}
              {example
                ? 'Example only'
                : `Cost ${usd6(report.billing.actualUsd6)} · ${report.billing.state}`}
            </span>
            <span>
              {report.calibration.status === 'valid'
                ? `Calibrated · ${report.calibration.ageBand}${report.calibration.baseRate === null ? '' : ` · ${(report.calibration.baseRate * 100).toFixed(1)}% fell ≥90% within 24h`}`
                : 'Verdict calibration not active'}
            </span>
          </footer>
          {!!report.limitations.length && !example && (
            <details className="sl-disclosure">
              <summary>Coverage & limitations</summary>
              {report.limitations.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </details>
          )}
        </>
      )}
      {report && (
        <p className="sl-muted sl-report-disclaimer">
          Information, not advice. You decide.
        </p>
      )}
      {accountId && (
        <div className="sl-recent">
          <button
            className="sl-text-button"
            disabled={api.busy}
            onClick={() => void loadRecent()}
          >
            Recent checks & recovery
          </button>
          {historyLoaded && (
            <div>
              {recent.length ? (
                recent.map((item) => (
                  <button
                    className="sl-recent-row"
                    key={item.id}
                    disabled={api.busy}
                    onClick={() => {
                      setReport(item);
                      setExample(false);
                      setGroup('overview');
                      setSelected(null);
                      setReportId(item.id);
                    }}
                  >
                    <TokenAvatar mint={item.mint} size={22} />
                    <span>{shortAddress(item.mint)}</span>
                    <span>{verdictLabel[item.verdict]}</span>
                    <small>{utcTime(item.updatedAt)} UTC</small>
                  </button>
                ))
              ) : (
                <p className="sl-muted">No saved reports yet.</p>
              )}
              {nextCursor && (
                <button
                  className="sl-text-button"
                  disabled={api.busy}
                  onClick={() => void loadRecent(nextCursor)}
                >
                  Load earlier checks
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {accountId && (
        <details className="sl-disclosure sl-open-report">
          <summary>Open a saved report</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!/^[0-9a-f-]{36}$/i.test(reportId)) {
                api.setError('Enter a valid report ID.');
                return;
              }
              void run(async (request) => {
                const result = await request(
                  `second-look/reports/${reportId}`,
                  { validate: reportResponse },
                );
                setReport(result.report);
                setExample(false);
              });
            }}
          >
            <input
              aria-label="Report ID"
              placeholder="Report ID"
              value={reportId}
              onChange={(e) => setReportId(e.target.value)}
            />
            <button className="sl-button" disabled={api.busy}>
              Open
            </button>
          </form>
        </details>
      )}
      {!!candidates.length && (
        <Modal title="Choose the exact token" onClose={() => setCandidates([])}>
          <p className="sl-muted">
            Names can be reused. Match the mint address before continuing.
          </p>
          <div className="sl-candidates">
            {candidates.map((candidate) => (
              <button
                key={candidate.mint}
                onClick={() => void requestQuote(candidate.mint)}
                disabled={api.busy}
              >
                <TokenAvatar mint={candidate.mint} size={28} />
                <span>
                  <strong>
                    {candidate.name} · {candidate.symbol}
                  </strong>
                  <code>{candidate.mint}</code>
                  <small>
                    {candidate.lookalike
                      ? 'Similar name · verify carefully'
                      : 'Confirm this address'}
                  </small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </Modal>
      )}
      {quote && (
        <Modal
          title={
            quote.mode === 'deep' ? 'Review Deep Check' : 'Review Token Check'
          }
          onClose={() => {
            if (!api.busy) setQuote(null);
          }}
        >
          <p className="sl-muted">
            {quote.mode === 'deep'
              ? 'Launch replay and previously verified project claims, with source evidence.'
              : 'Thirteen checks against available Solana and market sources.'}
          </p>
          <code className="sl-full-address">{quote.mint}</code>
          <dl className="sl-quote">
            <div>
              <dt>Maximum cost</dt>
              <dd>
                {quote.maximumUsd6 === '0' ? 'Free' : usd6(quote.maximumUsd6)}
              </dd>
            </div>
            <div>
              <dt>Free checks remaining</dt>
              <dd>{quote.freeRemaining}</dd>
            </div>
            <div>
              <dt>Quote expires</dt>
              <dd>{utcTime(quote.expiresAt)} UTC</dd>
            </div>
          </dl>
          {quote.limitations.map((line, i) => (
            <p className="sl-muted" key={i}>
              {line}
            </p>
          ))}
          <ErrorNotice message={api.error} />
          {approvalAttempted && api.error && (
            <p className="sl-muted">
              The result may already be saved. Recover this same check before
              starting another, or open Recent checks after returning to this
              page.
            </p>
          )}
          <button
            className="sl-button sl-primary sl-wide"
            disabled={
              api.busy ||
              (!approvalAttempted && Date.parse(quote.expiresAt) <= now)
            }
            onClick={() => void approve()}
          >
            {api.busy ? (
              <Busy label="Running check" />
            ) : approvalAttempted ? (
              'Recover saved check'
            ) : quote.maximumUsd6 === '0' ? (
              'Run free check'
            ) : (
              `Approve up to ${usd6(quote.maximumUsd6)}`
            )}
          </button>
        </Modal>
      )}
    </section>
  );
}
