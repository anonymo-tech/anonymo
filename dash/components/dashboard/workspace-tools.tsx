'use client';

import { useT } from '@/lib/i18n';

import { useId, useState, type ReactNode } from 'react';
import Link from '@/components/site-link';
import { Check, Info, LockKeyhole } from 'lucide-react';
import { MotionIcon } from './motion-icon';
import { LiveIdentityPanel } from './live-identity-panel';
import { LiveRoutesPanel } from './live-routes-panel';
import { LiveExplainerPanel } from './live-explainer-panel';
import { LiveCrossCheckPanel } from './live-crosscheck-panel';
import type { ServiceRoute } from '../../lib/client/workspace';
import { MODELS, type DemoModel } from './data';

export type ToolView =
  | 'routes'
  | 'explainer'
  | 'crosscheck'
  | 'settings'
  | 'identity'
  | 'help';

type ToolsContentProps = {
  service?: {
    accountId: string | null;
    routes: ServiceRoute[];
    /** Account session state for Settings; omitted values read as signed out. */
    signedIn?: boolean;
    liveInference?: boolean;
    internalTestCredit?: boolean;
  };
  view: ToolView;
  modelId?: string;
  onClose: () => void;
  onToast: (message: string) => void;
};

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="ct-note">
      <Info size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function SourceLink({ href, children }: { href: string; children: ReactNode }) {
  const t = useT();
  return (
    <a
      data-icon-trigger
      className="ct-source"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
      <MotionIcon name="open" size={20} />
      <span className="ct-sr-only">{t(' (opens in a new tab)')}</span>
    </a>
  );
}

function RouteDetails({ model }: { model: DemoModel }) {
  const t = useT();
  const headingId = useId();
  return (
    <section className="ct-detail" aria-labelledby={headingId}>
      <div className="ct-detail-heading">
        <div>
          <span className="ct-eyebrow">{t('Sample route')}</span>
          <h3 id={headingId}>{model.name}</h3>
        </div>
        <span className="ct-status">{t('UNVERIFIED')}</span>
      </div>
      <dl className="ct-facts">
        <div>
          <dt>{t('Design target')}</dt>
          <dd className="ct-code">{t(model.level.replaceAll('_', ' '))}</dd>
        </div>
        <div>
          <dt>{t('Provider connection')}</dt>
          <dd>{t('Not configured')}</dd>
        </div>
        <div>
          <dt>{t('Prompt handling')}</dt>
          <dd>
            {model.kind === 'Sealed'
              ? t(
                  'Would require encryption to an attested host. Neither is connected.',
                )
              : t(
                  'A connected route would expose the prompt to the processing provider.',
                )}
          </dd>
        </div>
        <div>
          <dt>{t('Retention & training')}</dt>
          <dd>{t('No verified policy')}</dd>
        </div>
        <div>
          <dt>{t('Evidence')}</dt>
          <dd>{t('No live route or attestation evidence')}</dd>
        </div>
        <div>
          <dt>{t('Sample estimate')}</dt>
          <dd>
            {t('{amount} USDC per call · 0 charged', {
              amount: model.cost.toFixed(3),
            })}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function RoutesPanel({ modelId }: Pick<ToolsContentProps, 'modelId'>) {
  const t = useT();
  const [selectedId, setSelectedId] = useState(
    () => MODELS.find((model) => model.id === modelId)?.id || MODELS[0].id,
  );
  const selected = MODELS.find((model) => model.id === selectedId) || MODELS[0];
  return (
    <>
      <p className="ct-intro">
        {t(
          'Inspect a model’s proposed route. Every route in this workspace is a local sample.',
        )}
      </p>
      <div className="ct-models" aria-label={t('Sample route details')}>
        {MODELS.map((model) => (
          <button
            data-icon-trigger
            className="ct-model"
            type="button"
            key={model.id}
            aria-pressed={selectedId === model.id}
            onClick={() => setSelectedId(model.id)}
          >
            <span className="ct-monogram" aria-hidden="true">
              {model.monogram}
            </span>
            <span className="ct-model-name">
              <strong>{model.name}</strong>
              <small>
                {t('{family} · {kind} concept', {
                  family: model.family,
                  kind: t(model.kind),
                })}
              </small>
            </span>
            {selectedId === model.id && <Check size={14} aria-hidden="true" />}
          </button>
        ))}
      </div>
      <RouteDetails model={selected} />
      <Note>
        {t(
          'Selecting a card only opens its details. It does not change your project’s models or activate a privacy guarantee.',
        )}
      </Note>
      <Link data-icon-trigger className="ct-source" href="/docs#routes">
        {t('Read about route levels ')}
        <MotionIcon name="open" size={20} />
      </Link>
    </>
  );
}

const SOLANA_EXAMPLES = [
  {
    id: 'transfer',
    label: 'SOL transfer',
    title: 'A transfer has a sender, recipient and amount.',
    description:
      'This example describes a transfer instruction. The account labels are symbolic; no transaction has been built or submitted.',
    rows: [
      ['Instruction', 'System Program · transfer'],
      ['Sender', 'Sample sender'],
      ['Recipient', 'Sample recipient'],
      ['Amount', '0.25 SOL · illustrative'],
    ],
    takeaway:
      'A real review also needs the full transaction: every instruction, signer, writable account and fee payer.',
    source: 'https://solana.com/docs/core/transactions',
    sourceName: 'Solana documentation · Transactions',
  },
  {
    id: 'authority',
    label: 'Authority change',
    title: 'An authority change affects a specific permission.',
    description:
      'The Token Program’s SetAuthority instruction changes an authority role on a mint or token account. The meaning depends on which role changes.',
    rows: [
      ['Instruction', 'Token Program · SetAuthority'],
      ['Authority type', 'Account owner · example'],
      ['Current authority', 'Sample current owner'],
      ['New authority', 'Sample replacement owner'],
    ],
    takeaway:
      'Read the authority type and destination together. A mint authority, account owner and close authority have different permissions.',
    source: 'https://solana.com/docs/tokens/basics/set-authority',
    sourceName: 'Solana documentation · Set Authority',
  },
  {
    id: 'fees',
    label: 'Failure & fees',
    title: 'Reverted changes do not mean a free transaction.',
    description:
      'If an instruction fails, the transaction’s state changes are reverted. A transaction processed by the network can still incur a fee.',
    rows: [
      ['Example outcome', 'Instruction failed'],
      ['State changes', 'Reverted'],
      ['Network fee', 'Can still be charged'],
      ['This workspace', '0 charged · no network request'],
    ],
    takeaway:
      'A preview is not a guarantee of the eventual outcome. This example does not simulate execution or estimate a live fee.',
    source: 'https://solana.com/docs/core/transactions',
    sourceName: 'Solana documentation · Transactions',
  },
] as const;

function ExplainerPanel() {
  const t = useT();
  const [exampleId, setExampleId] = useState<string>(SOLANA_EXAMPLES[0].id);
  const example =
    SOLANA_EXAMPLES.find((item) => item.id === exampleId) || SOLANA_EXAMPLES[0];
  return (
    <>
      <p className="ct-intro">
        {t(
          'Read a Solana example in plain language. No RPC connection, wallet signature or onchain action.',
        )}
      </p>
      <div className="ct-segments" aria-label={t('Solana examples')}>
        {SOLANA_EXAMPLES.map((item) => (
          <button
            data-icon-trigger
            key={item.id}
            type="button"
            aria-pressed={item.id === exampleId}
            onClick={() => setExampleId(item.id)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <section className="ct-detail ct-example">
        <span className="ct-eyebrow">{t('Educational sample')}</span>
        <h3>{t(example.title)}</h3>
        <p>{t(example.description)}</p>
        <dl className="ct-facts">
          {example.rows.map(([label, value]) => (
            <div key={label}>
              <dt>{t(label)}</dt>
              <dd>{t(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="ct-takeaway">{t(example.takeaway)}</p>
      </section>
      <SourceLink href={example.source}>{t(example.sourceName)}</SourceLink>
    </>
  );
}

const CHECK_EXAMPLES = [
  {
    id: 'fees',
    label: 'Transaction fees',
    claim: 'A failed Solana transaction never costs SOL.',
    verdict: 'The absolute claim is unsupported.',
    summary:
      'The sample reviews separate reverted state changes from transaction fees. Their reasoning stays visible instead of becoming a single confidence score.',
    reviews: [
      {
        label: 'Contradicted',
        text: 'The source explicitly says a fee can remain after a transaction fails.',
      },
      {
        label: 'Incomplete framing',
        text: 'State rollback and fee charging are different parts of the transaction outcome.',
      },
      {
        label: 'Needs context',
        text: 'Distinguish a transaction processed onchain from one that was never submitted.',
      },
    ],
    quote: 'Fees are still charged on failure.',
    source: 'https://solana.com/docs/core/transactions',
    sourceName: 'Solana documentation · Transactions',
  },
  {
    id: 'authority',
    label: 'Authority scope',
    claim: 'Every authority change gives another wallet full control.',
    verdict: 'The scope matters. Keep the dissent.',
    summary:
      'The sample reviews disagree on how to frame the claim. All need the actual authority type before drawing a conclusion about its effects.',
    reviews: [
      {
        label: 'Too broad',
        text: 'Changing a mint authority does not describe every other authority or account permission.',
      },
      {
        label: 'Cannot conclude',
        text: 'The claim does not name the account, authority type or new authority.',
      },
      {
        label: 'Narrow the claim',
        text: 'Describe the one permission being changed, then review its consequences.',
      },
    ],
    quote: 'Each call updates one authority type on one mint or token account.',
    source: 'https://solana.com/docs/tokens/basics/set-authority',
    sourceName: 'Solana documentation · Set Authority',
  },
] as const;

function CrossCheckPanel({ onToast }: Pick<ToolsContentProps, 'onToast'>) {
  const t = useT();
  const [exampleId, setExampleId] = useState<string>(CHECK_EXAMPLES[0].id);
  const example =
    CHECK_EXAMPLES.find((item) => item.id === exampleId) || CHECK_EXAMPLES[0];
  async function copySummary() {
    try {
      await navigator.clipboard.writeText(
        t(
          'Conclave · Sample Cross-Check\nPrewritten example; no model or retrieval request.\n\nClaim: {claim}\n{verdict}\n\n{reviews}\n\nSource: {source}',
          {
            claim: t(example.claim),
            verdict: t(example.verdict),
            reviews: example.reviews
              .map((review) =>
                t('{label}: {text}', {
                  label: t(review.label),
                  text: t(review.text),
                }),
              )
              .join('\n'),
            source: example.source,
          },
        ),
      );
      onToast(t('Sample Cross-Check copied.'));
    } catch {
      onToast(
        t('Clipboard unavailable. You can select and copy the sample text.'),
      );
    }
  }
  return (
    <>
      <p className="ct-intro">
        {t(
          'Explore how a claim, its sources and differing readings fit together. These are prewritten examples, not live model reviews.',
        )}
      </p>
      <div className="ct-segments" aria-label={t('Cross-Check samples')}>
        {CHECK_EXAMPLES.map((item) => (
          <button
            data-icon-trigger
            type="button"
            key={item.id}
            aria-pressed={item.id === exampleId}
            onClick={() => setExampleId(item.id)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <section className="ct-claim">
        <span className="ct-eyebrow">{t('Sample claim')}</span>
        <p>{t(example.claim)}</p>
      </section>
      <div className="ct-reviews">
        {example.reviews.map((review, index) => (
          <article key={review.label} className="ct-review">
            <span className="ct-eyebrow">
              {t('Sample perspective {number}', { number: index + 1 })}
            </span>
            <h3>{t(review.label)}</h3>
            <p>{t(review.text)}</p>
          </article>
        ))}
      </div>
      <section className="ct-evidence">
        <span className="ct-eyebrow">{t('Source excerpt')}</span>
        <blockquote>“{t(example.quote)}”</blockquote>
        <SourceLink href={example.source}>{t(example.sourceName)}</SourceLink>
      </section>
      <div className="ct-result">
        <h3>{t(example.verdict)}</h3>
        <p>{t(example.summary)}</p>
      </div>
      <button
        data-icon-trigger
        className="ct-button"
        type="button"
        onClick={() => {
          void copySummary();
        }}
      >
        <MotionIcon name="copy" size={20} />
        {t(' Copy sample summary')}
      </button>
    </>
  );
}

function LiveSettingsPanel({
  service,
}: {
  service: NonNullable<ToolsContentProps['service']>;
}) {
  const t = useT();
  const { signedIn = false, liveInference = false } = service;
  return (
    <>
      <p className="ct-intro">
        {t('What is active for your account in this browser.')}
      </p>
      <dl className="ct-settings">
        <div>
          <dt>{t('Workspace')}</dt>
          <dd>
            <strong>
              {signedIn ? t('Signed-in account') : t('Signed out')}
            </strong>
            <span>
              {signedIn
                ? t(
                    'Projects and answers are saved to your account. Drafts stay in this tab.',
                  )
                : t('Sign in from Account & wallet to open your projects.')}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t('Model responses')}</dt>
          <dd>
            <strong>
              {liveInference
                ? t('Live inference')
                : t('Live inference unavailable')}
            </strong>
            <span>
              {liveInference
                ? t(
                    'Sent through reviewed routes only after you approve the cost.',
                  )
                : signedIn
                  ? t(
                      'No reviewed route is available right now. Nothing is sent.',
                    )
                  : t('Sign in to use reviewed model routes.')}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t('Prompt guard')}</dt>
          <dd>
            <strong>{t('Local pattern check')}</strong>
            <span>
              {t(
                'Runs before every quote. It can miss secrets, so keep sensitive information out of your questions.',
              )}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t('Balance & charges')}</dt>
          <dd>
            <strong>
              {!signedIn
                ? t('Not signed in')
                : service.internalTestCredit
                  ? t('Internal test credit')
                  : t('Prepaid account balance')}
            </strong>
            <span>
              {!signedIn
                ? t(
                    'Nothing is reserved or charged until you sign in and approve a request.',
                  )
                : service.internalTestCredit
                  ? t(
                      'Charges apply. Approved requests reserve and settle against test credit, which is not USDC.',
                    )
                  : t(
                      'Charges apply. Each approved request reserves its maximum and settles verified usage.',
                    )}
            </span>
          </dd>
        </div>
      </dl>
      <Note>
        {t(
          'Standard routes are not private: the gateway and the model provider receive each question in plaintext.',
        )}
      </Note>
      <Link data-icon-trigger className="ct-source" href="/docs">
        {t('Open the field guide ')}
        <MotionIcon name="open" size={20} />
      </Link>
    </>
  );
}

function SettingsPanel() {
  const t = useT();
  return (
    <>
      <p className="ct-intro">{t('What is active in this browser.')}</p>
      <dl className="ct-settings">
        <div>
          <dt>{t('Workspace')}</dt>
          <dd>
            <strong>{t('Local demo')}</strong>
            <span>{t('No cloud account or team sync.')}</span>
          </dd>
        </div>
        <div>
          <dt>{t('Model responses')}</dt>
          <dd>
            <strong>{t('Sample content')}</strong>
            <span>{t('Live inference is not connected.')}</span>
          </dd>
        </div>
        <div>
          <dt>{t('Prompt guard')}</dt>
          <dd>
            <strong>{t('Local pattern check')}</strong>
            <span>
              {t(
                'It can miss secrets. Keep sensitive information out of the demo.',
              )}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t('Wallet & payments')}</dt>
          <dd>
            <strong>{t('Not connected')}</strong>
            <span>{t('No signatures, deposits or charges.')}</span>
          </dd>
        </div>
      </dl>
      <Note>
        {t(
          'Browser-local data is not an encrypted vault. Other people using the same browser profile may be able to read it.',
        )}
      </Note>
      <Link data-icon-trigger className="ct-source" href="/docs#guards">
        {t('Understand the demo’s limits ')}
        <MotionIcon name="open" size={20} />
      </Link>
    </>
  );
}

function IdentityPanel({ onClose }: { onClose: () => void }) {
  return <LiveIdentityPanel onClose={onClose} />;
}

function HelpPanel() {
  const t = useT();
  return (
    <>
      <p className="ct-intro">
        {t(
          'Write a question, explore sample perspectives and keep useful thinking in your workspace.',
        )}
      </p>
      <dl className="ct-shortcuts">
        <div>
          <dt>
            <kbd>Ctrl</kbd>
            <span> + </span>
            <kbd>Enter</kbd>
          </dt>
          <dd>{t('Send a sample message')}</dd>
        </div>
        <div>
          <dt>
            <kbd>Esc</kbd>
          </dt>
          <dd>{t('Close an open menu or dialog')}</dd>
        </div>
        <div>
          <dt>
            <kbd>Tab</kbd>
          </dt>
          <dd>{t('Move between controls')}</dd>
        </div>
      </dl>
      <section className="ct-help-section">
        <h3>{t('Choose your view')}</h3>
        <p>
          {t(
            'Use the view toggle in the workspace toolbar to change the layout.',
          )}
        </p>
      </section>
      <section className="ct-help-section">
        <h3>{t('Keep the limits in view')}</h3>
        <p>
          {t(
            'Responses are samples. Cross-Check does not retrieve live evidence, and the Solana explainer does not simulate or sign transactions.',
          )}
        </p>
      </section>
      <Link data-icon-trigger className="ct-source" href="/docs">
        {t('Open the field guide ')}
        <MotionIcon name="open" size={20} />
      </Link>
    </>
  );
}

export function ToolsContent({
  service,
  view,
  modelId,
  onClose,
  onToast,
}: ToolsContentProps) {
  const t = useT();
  return (
    <div className={`ct-tools${view === 'identity' ? ' ca-tools' : ''}`}>
      {view === 'routes' &&
        (service ? (
          <LiveRoutesPanel routes={service.routes} modelId={modelId} />
        ) : (
          <RoutesPanel key={modelId || 'default'} modelId={modelId} />
        ))}
      {view === 'explainer' &&
        (service ? (
          <LiveExplainerPanel
            key={service.accountId ?? 'signed-out'}
            accountId={service.accountId}
          />
        ) : (
          <ExplainerPanel />
        ))}
      {view === 'crosscheck' &&
        (service ? (
          <LiveCrossCheckPanel
            key={service.accountId ?? 'signed-out'}
            accountId={service.accountId}
          />
        ) : (
          <CrossCheckPanel onToast={onToast} />
        ))}
      {view === 'settings' &&
        (service ? <LiveSettingsPanel service={service} /> : <SettingsPanel />)}
      {view === 'identity' && <IdentityPanel onClose={onClose} />}
      {view === 'help' && <HelpPanel />}
      {view !== 'identity' && (
        <div className="ct-footer">
          <span>
            <LockKeyhole size={12} aria-hidden="true" />{' '}
            {service ? t('Account') : t('Local demo')}
          </span>
          <button
            data-icon-trigger
            className="ct-button ct-button-primary"
            type="button"
            onClick={onClose}
          >
            {t('Done')}
          </button>
        </div>
      )}
    </div>
  );
}

export default ToolsContent;
