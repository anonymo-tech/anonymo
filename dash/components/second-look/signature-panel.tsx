'use client';
import { useEffect, useImperativeHandle, useState } from 'react';
import {
  ArrowRight,
  ShieldCheck,
  Braces,
  Link2,
  Globe2,
  MessageSquare,
  Smartphone,
  CircleAlert,
} from 'lucide-react';
import type {
  SignatureInput,
  SignatureReport,
  SignatureCapability,
} from '../../lib/second-look/signature';
import {
  signatureResponse,
  signatureCapabilitiesResponse,
} from '../../lib/client/second-look-contracts';
import { decimalAmount, shortAddress } from '../../lib/client/second-look';
import { readableCode, tokenIdentity, utcTime } from './presentation';
import {
  Busy,
  CopyButton,
  ErrorNotice,
  EvidenceLink,
  useSecondLookApi,
  type PanelProps,
} from './shared';
const kinds = [
  {
    id: 'transaction',
    label: 'Transaction',
    icon: Braces,
    placeholder: 'Paste an unsigned transaction…',
  },
  {
    id: 'action',
    label: 'Blink / Action',
    icon: Link2,
    placeholder: 'Paste a Blink or Solana Action link…',
  },
  {
    id: 'message',
    label: 'Message',
    icon: MessageSquare,
    placeholder: 'Paste the message you were asked to sign…',
  },
  {
    id: 'domain',
    label: 'Website',
    icon: Globe2,
    placeholder: 'Paste a website address to inspect…',
  },
  {
    id: 'app',
    label: 'App',
    icon: Smartphone,
    placeholder: 'Paste an Android package name or Google Play link…',
  },
] as const;
export function SignaturePanel({
  accountId,
  controlRef,
  onComposer,
  onSignIn,
  onDraft,
  onToast,
}: PanelProps) {
  const api = useSecondLookApi(accountId);
  const { run } = api;
  const [capability, setCapability] = useState<SignatureCapability | null>(
    null,
  );
  const [kind, setKind] = useState<SignatureInput['kind']>('transaction');
  const [report, setReport] = useState<SignatureReport | null>(null);
  const [encoding, setEncoding] = useState<'base64' | 'base58'>('base64');
  const [origin, setOrigin] = useState('');
  const [actionAccount, setActionAccount] = useState('');
  const [actionHref, setActionHref] = useState('');
  const [actionConsent, setActionConsent] = useState(false);
  const [certificate, setCertificate] = useState('');
  const [expectedRecipients, setExpectedRecipients] = useState('');
  const [swap, setSwap] = useState(false);
  useEffect(() => {
    if (!accountId) return;
    void run(async (request) => {
      const result = await request('second-look/signature/capabilities', {
        validate: signatureCapabilitiesResponse,
      });
      setCapability(result);
      if (!result.transactionSimulation) setKind('domain');
    });
  }, [accountId, run]);
  useEffect(() => {
    onComposer({
      placeholder: kinds.find((k) => k.id === kind)!.placeholder,
      label: 'Inspect request',
      busy: api.busy,
    });
  }, [kind, api.busy, onComposer]);
  useImperativeHandle(controlRef, () => ({
    async submit(value) {
      if (!accountId) {
        api.setError('Sign in to inspect this request.');
        onSignIn();
        return;
      }
      if (
        kind === 'action' &&
        (!actionConsent ||
          !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(actionAccount.trim()))
      ) {
        api.setError(
          'Enter a public wallet address and confirm sharing it with the reviewed Action endpoint.',
        );
        return;
      }
      if (
        (kind === 'transaction' &&
          capability?.transactionSimulation === false) ||
        (kind === 'action' && capability?.actionUrlResolution === false)
      ) {
        api.setError(
          'This inspection source is not connected yet. Website and message checks are available.',
        );
        return;
      }
      const normalizedCertificate = certificate.replace(/[:\s]/g, '');
      if (
        kind === 'app' &&
        normalizedCertificate &&
        !/^[a-fA-F0-9]{64}$/.test(normalizedCertificate)
      ) {
        api.setError(
          'Enter a 64-character SHA-256 fingerprint, or leave it blank.',
        );
        return;
      }
      const input: SignatureInput =
        kind === 'action'
          ? {
              kind,
              url: value.trim(),
              account: actionAccount.trim(),
              ...(actionHref.trim() ? { actionHref: actionHref.trim() } : {}),
              ...(swap ? { intent: 'swap' as const } : {}),
              ...(swap && expectedRecipients.trim()
                ? {
                    expectedRecipients: expectedRecipients
                      .split(/[\s,]+/)
                      .filter(Boolean),
                  }
                : {}),
            }
          : kind === 'transaction'
            ? {
                kind,
                transaction: value.trim(),
                encoding,
                ...(swap ? { intent: 'swap' as const } : {}),
                ...(swap && expectedRecipients.trim()
                  ? {
                      expectedRecipients: expectedRecipients
                        .split(/[\s,]+/)
                        .filter(Boolean),
                    }
                  : {}),
              }
            : kind === 'message'
              ? { kind, message: value, pageOrigin: origin.trim() || null }
              : kind === 'domain'
                ? { kind, url: value.trim() }
                : {
                    kind,
                    packageName: value.trim(),
                    ...(normalizedCertificate
                      ? { certificateSha256: normalizedCertificate }
                      : {}),
                  };
      await api.run(async (request) => {
        const result = await request('second-look/signature/inspect', {
          body: input,
          validate: signatureResponse,
        });
        setReport(result.report);
        onDraft('');
      });
    },
  }));
  return (
    <section aria-label="Signature Firewall">
      <div className="sl-signature-heading">
        <div>
          <span className="sl-eyebrow">SIGNATURE FIREWALL</span>
          <h2>
            Understand the request.
            <br />
            Before you sign.
          </h2>
          <p>
            Inspect permissions, balance changes and known drainer patterns.
          </p>
        </div>
        <span className="sl-readonly">
          <ShieldCheck size={14} />
          Inspection only
        </span>
      </div>
      <nav className="sl-kind-nav" aria-label="Request type">
        {kinds.map((item) => (
          <button
            key={item.id}
            aria-pressed={kind === item.id}
            disabled={
              api.busy ||
              (item.id === 'transaction' &&
                capability?.transactionSimulation === false) ||
              (item.id === 'action' &&
                capability?.actionUrlResolution === false)
            }
            title={
              item.id === 'action' && capability?.actionUrlResolution === false
                ? 'Reviewed Action endpoints are not connected yet'
                : item.id === 'transaction' &&
                    capability?.transactionSimulation === false
                  ? 'Transaction simulation is not connected yet'
                  : undefined
            }
            onClick={() => {
              setKind(item.id);
              setReport(null);
              api.setError('');
              onDraft('');
            }}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sl-signature-options">
        {kind === 'transaction' || kind === 'action' ? (
          <>
            {kind === 'transaction' && (
              <label>
                Encoding
                <select
                  value={encoding}
                  onChange={(e) =>
                    setEncoding(e.target.value as 'base64' | 'base58')
                  }
                >
                  <option value="base64">Base64</option>
                  <option value="base58">Base58</option>
                </select>
              </label>
            )}
            <label className="sl-checkbox">
              <input
                type="checkbox"
                checked={swap}
                onChange={(e) => setSwap(e.target.checked)}
              />
              Expecting a swap
            </label>
            <details>
              <summary>Expected recipients</summary>
              <label className="sl-field">
                Public addresses
                <input
                  value={expectedRecipients}
                  disabled={!swap || api.busy}
                  onChange={(e) => setExpectedRecipients(e.target.value)}
                  placeholder="Optional · comma separated"
                  maxLength={1000}
                />
              </label>
            </details>
          </>
        ) : kind === 'message' ? (
          <label className="sl-field">
            Page origin <span>optional</span>
            <input
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="https://example.com"
              maxLength={2048}
            />
          </label>
        ) : kind === 'app' ? (
          <label className="sl-field">
            Certificate SHA-256 <span>optional</span>
            <input
              value={certificate}
              onChange={(e) => setCertificate(e.target.value)}
              placeholder="Android signing certificate fingerprint"
              maxLength={95}
            />
          </label>
        ) : (
          <p className="sl-muted">
            Checks the domain name and available reputation evidence.
          </p>
        )}
      </div>
      {kind === 'action' && (
        <div className="sl-action-options">
          <label className="sl-field">
            Public wallet address
            <input
              value={actionAccount}
              onChange={(e) => {
                setActionAccount(e.target.value);
                setActionConsent(false);
              }}
              maxLength={44}
              placeholder="Address to inspect the request for"
            />
          </label>
          <details className="sl-disclosure">
            <summary>Linked action URL · optional</summary>
            <label className="sl-field">
              Exact reviewed action
              <input
                value={actionHref}
                onChange={(e) => {
                  setActionHref(e.target.value);
                  setActionConsent(false);
                }}
                maxLength={2048}
                placeholder="Only for an Action with multiple choices"
              />
            </label>
          </details>
          <label className="sl-checkbox">
            <input
              type="checkbox"
              checked={actionConsent}
              onChange={(e) => setActionConsent(e.target.checked)}
            />
            Send this public address to the reviewed Action endpoint to request
            unsigned transaction bytes.
          </label>
          <p className="sl-muted">
            Only configured, reviewed endpoints are supported. Nothing is signed
            or submitted to the chain.
          </p>
        </div>
      )}
      <ErrorNotice message={api.error} />
      {api.busy && (
        <div className="sl-progress">
          <Busy label="Inspecting request" />
        </div>
      )}
      {!report ? (
        <div className="sl-inspection-empty">
          <div className="sl-list-head">
            <span>What you’ll see</span>
            <span>Evidence</span>
          </div>
          {(kind === 'transaction' || kind === 'action'
            ? [
                [
                  'Permissions requested',
                  'Authority changes, approvals and transfers',
                ],
                ['Before → after', 'Simulated changes for every signer'],
                [
                  'Anything unresolved',
                  'Unknown programs and missing coverage',
                ],
              ]
            : kind === 'message'
              ? [
                  ['Signing intent', 'Login request or unexpected permission'],
                  ['Origin match', 'Domain, URI and session context'],
                  ['Hidden payloads', 'Transaction-like or misleading content'],
                ]
              : kind === 'domain'
                ? [
                    [
                      'Domain identity',
                      'Lookalikes and internationalized names',
                    ],
                    ['Reputation', 'Available blocklist evidence'],
                    ['Registration', 'Age when registry data is available'],
                  ]
                : [
                    ['Package identity', 'Exact application package name'],
                    [
                      'Certificate',
                      'Match against reviewed certificate records',
                    ],
                    ['Listing', 'Reviewed store evidence when available'],
                  ]
          ).map(([title, detail]) => (
            <div className="sl-inspection-line" key={title}>
              <span>{title}</span>
              <span>{detail}</span>
            </div>
          ))}
          <p className="sl-muted">
            Paste the request in the bar below. Conclave never signs or submits
            it.
          </p>
        </div>
      ) : (
        <div className="sl-signature-result">
          <div className={`sl-verdict sl-verdict-${report.verdict}`}>
            <span className="sl-status-dot" />
            <div>
              <strong>{report.verdictLabel}</strong>
              <p>
                {report.kind === 'transaction'
                  ? 'Review every permission and signer below.'
                  : 'Based on the evidence available at inspection time.'}
              </p>
            </div>
            <span>{utcTime(report.inspectedAt)} UTC</span>
          </div>
          <div className="sl-section-heading">
            <h3>Findings</h3>
            <CopyButton
              value={JSON.stringify(report, null, 2)}
              label="Copy inspection report"
              onToast={onToast}
            />
          </div>
          {report.findings.map((finding, i) => (
            <div
              className={`sl-finding sl-severity-${finding.severity}`}
              key={i}
            >
              <CircleAlert size={15} />
              <div>
                <strong>{readableCode(finding.code)}</strong>
                <p>{finding.message}</p>
                {finding.instruction && <small>{finding.instruction}</small>}
              </div>
            </div>
          ))}
          {!report.findings.length && (
            <p className="sl-muted">
              No matching findings in the inspected data.
            </p>
          )}
          {!!report.permissions.length && (
            <>
              <div className="sl-section-heading">
                <h3>Permissions & instructions</h3>
                <span>{report.permissions.length}</span>
              </div>
              {report.permissions.map((permission, i) => (
                <details className="sl-disclosure" key={i}>
                  <summary>
                    {permission.instruction} · {readableCode(permission.kind)}
                  </summary>
                  <dl>
                    {Object.entries(permission.fields).map(([key, value]) => (
                      <div key={key}>
                        <dt>{readableCode(key)}</dt>
                        <dd className="sl-wrap">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {permission.programId && (
                    <EvidenceLink
                      href={`https://solscan.io/account/${permission.programId}`}
                    >
                      Program {shortAddress(permission.programId)}
                    </EvidenceLink>
                  )}
                </details>
              ))}
            </>
          )}
          {(report.kind === 'transaction' || report.kind === 'action') && (
            <>
              <div className="sl-section-heading">
                <h3>Signer balance changes</h3>
                <span>{readableCode(report.balances.status)}</span>
              </div>
              {report.balances.signers.length ? (
                report.balances.signers.map((signer) => (
                  <div key={signer.signer} className="sl-signer">
                    <div className="sl-address">
                      <strong>{shortAddress(signer.signer)}</strong>
                      <CopyButton value={signer.signer} onToast={onToast} />
                    </div>
                    {signer.sol && (
                      <div className="sl-balance-change">
                        <span>SOL</span>
                        <span>
                          {decimalAmount(signer.sol.beforeLamports, 9, 6)}
                        </span>
                        <ArrowRight size={14} />
                        <span>
                          {decimalAmount(signer.sol.afterLamports, 9, 6)}
                        </span>
                      </div>
                    )}
                    {!signer.sol && (
                      <p className="sl-muted">
                        SOL balance changes were not returned by the simulation.
                      </p>
                    )}
                    {signer.tokens.map((token) => (
                      <div className="sl-balance-change" key={token.account}>
                        <span>{tokenIdentity(token.mint).symbol}</span>
                        <span>
                          {decimalAmount(token.beforeAmount, token.decimals, 5)}
                        </span>
                        <ArrowRight size={14} />
                        <span>
                          {decimalAmount(token.afterAmount, token.decimals, 5)}
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              ) : (
                <p className="sl-muted">
                  No verified balance simulation is available.
                </p>
              )}
              <p className="sl-muted">
                Reported transaction accounts only. This does not include every
                wallet holding.
              </p>
            </>
          )}
          {report.domain && (
            <dl className="sl-inspection-facts">
              <div>
                <dt>Domain</dt>
                <dd className="sl-wrap">{report.domain.asciiHost}</dd>
              </div>
              <div>
                <dt>Lookalike</dt>
                <dd>
                  {report.domain.lookalike
                    ? 'Detected'
                    : 'No match in checked references'}
                </dd>
              </div>
              <div>
                <dt>Blocklist</dt>
                <dd>{readableCode(report.domain.blocklist)}</dd>
              </div>
              <div>
                <dt>Registration age</dt>
                <dd>
                  {report.domain.ageDays === null
                    ? 'Unknown'
                    : `${report.domain.ageDays} days`}
                </dd>
              </div>
            </dl>
          )}
          {report.app && (
            <dl className="sl-inspection-facts">
              <div>
                <dt>Package</dt>
                <dd>{report.app.packageName}</dd>
              </div>
              <div>
                <dt>Certificate</dt>
                <dd>{readableCode(report.app.certificate)}</dd>
              </div>
              <div>
                <dt>Listing</dt>
                <dd>
                  <EvidenceLink href={report.app.listing}>
                    {report.app.listing ? 'Reviewed listing' : 'Unknown'}
                  </EvidenceLink>
                </dd>
              </div>
            </dl>
          )}
          {report.action && (
            <div className="sl-disclosure">
              <h3>Action evidence</h3>
              <p>
                <EvidenceLink href={report.action.endpoint}>
                  Metadata endpoint
                </EvidenceLink>{' '}
                ·{' '}
                <EvidenceLink href={report.action.transactionEndpoint}>
                  Transaction endpoint
                </EvidenceLink>
              </p>
              <p>
                Reviewed {utcTime(report.action.reviewedAt)} UTC · expires{' '}
                {utcTime(report.action.expiresAt)} UTC
              </p>
              <EvidenceLink href={report.action.source}>
                Review source
              </EvidenceLink>
            </div>
          )}
          {(report.domain?.sources ?? report.app?.sources ?? []).map(
            (source, i) => (
              <div className="sl-source" key={i}>
                <EvidenceLink href={source.url}>{source.label}</EvidenceLink>
                <small>
                  {utcTime(source.observedAt)} UTC
                  {source.expiresAt
                    ? ` · Expires ${utcTime(source.expiresAt)} UTC`
                    : ''}
                </small>
              </div>
            ),
          )}
          {!!report.coverage.unknowns.length && (
            <details className="sl-disclosure" open>
              <summary>What this inspection could not establish</summary>
              {report.coverage.unknowns.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </details>
          )}
        </div>
      )}
    </section>
  );
}
