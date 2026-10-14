'use client';

import { useEffect, useState } from 'react';
import Link from '@/components/site-link';
import Image from 'next/image';
import { HorseMark } from '@/components/conclave/horse-mark';
import { Wordmark } from '@/components/conclave/wordmark';
import { LanguageToggle } from '@/components/language-toggle';
import { useT } from '@/lib/i18n';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import './docs.css';

type TopicId =
  | 'routes'
  | 'guards'
  | 'compare'
  | 'billing'
  | 'chapters'
  | 'integrations';
type Topic = {
  id: TopicId;
  number: string;
  name: string;
  subtitle: string;
  introduction: string;
  keywords: string;
  facts: { title: string; copy: string }[];
};

const topics: Topic[] = [
  {
    id: 'routes',
    number: '01',
    name: 'Know your route',
    subtitle: 'Privacy has a definition.',
    introduction:
      'A model name tells you who answers. A Route Card tells you where your request goes, what the host can see, and which promises have evidence behind them.',
    keywords:
      'privacy retention strict sanctum local models evidence attestation',
    facts: [
      {
        title: 'Read before you send',
        copy: 'Every provider × model route needs its own card. Look for retention, training use, jurisdiction, legal hold, and dated evidence. An unknown answer stays unverified.',
      },
      {
        title: 'Set your minimum',
        copy: 'Strict mode must refuse a route below your chosen policy. If an eligible provider is unavailable, the request stops. It must never silently choose a weaker route.',
      },
      {
        title: 'Understand Sanctum',
        copy: 'Sanctum is designed for supported open models in attested, sealed hardware. It does not make a frontier vendor unable to read your prompt. Hardware attestation also has limits.',
      },
    ],
  },
  {
    id: 'guards',
    number: '02',
    name: 'Before anything leaves',
    subtitle: 'A pause at the threshold.',
    introduction:
      'The guard layer is designed to inspect a request on your device before that request is built. The interactive example below uses harmless markers to explain the flow.',
    keywords: 'key leak secret seed api injection redact guard',
    facts: [
      {
        title: 'Key Guard',
        copy: 'The production requirement is to block checksum-valid seed phrases and supported private-key encodings. A pattern warning alone is not a complete key detector.',
      },
      {
        title: 'Leak Guard',
        copy: 'Common API secrets, JWTs, PEM blocks and environment-file values should be blocked or redacted by your choice. No detector can promise to catch every secret.',
      },
      {
        title: 'Context stays context',
        copy: 'Uploaded documents and pasted instructions are untrusted source material. The injection shield should quote them as data, rather than grant them authority over tools.',
      },
    ],
  },
  {
    id: 'compare',
    number: '03',
    name: 'A second opinion',
    subtitle: 'Let the differences show.',
    introduction:
      'Ask several models the same question. Keep the disagreement visible. A useful answer is one you can inspect, compare and make a decision from.',
    keywords: 'side by side brief cross-check consensus sources model blind',
    facts: [
      {
        title: 'Side by Side',
        copy: 'Compare up to four model responses. Blind mode conceals model labels until you vote, helping you choose the response before the brand.',
      },
      {
        title: 'The Brief',
        copy: 'Bring the responses into one document: each model’s summary, agreement and disagreement, sources, cost, and your own decision. Export it when the decision is ready.',
      },
      {
        title: 'Cross-Check',
        copy: 'At least three model families review claims independently against quoted source passages. They never see each other’s answers. Dissent stays visible; consensus can still be wrong.',
      },
    ],
  },
  {
    id: 'billing',
    number: '04',
    name: 'One balance',
    subtitle: 'Know the cost of a question.',
    introduction:
      'The intended billing model is prepaid usage. A maximum estimate is held before a call, actual cost is captured afterwards, and the remainder is released.',
    keywords: 'usdc sol price cost payment receipt balance top up',
    facts: [
      {
        title: 'Usage, with a visible margin',
        copy: 'The proposed pricing is provider cost + 5% for standard routes and + 15% for Sanctum. It is not final; a real quote must be shown before a paid request.',
      },
      {
        title: 'A receipt for the call',
        copy: 'Production receipts must include route, privacy level, model, cost and time. Cryptographic signatures and Solana inclusion are future integrations, not properties of the preview’s sample history.',
      },
      {
        title: 'Prepaid, not tradeable',
        copy: 'Credits are usage balances and cannot be transferred between accounts. Top-ups require a finalized on-chain deposit. Never send funds to a preview or a placeholder address.',
      },
    ],
  },
  {
    id: 'chapters',
    number: '05',
    name: 'Work as a Chapter',
    subtitle: 'A shared room. Clear boundaries.',
    introduction:
      'Chapters are designed for teams whose ownership and spending limits live in a Squads multisig. Members can join with a wallet or a passkey.',
    keywords: 'team squads owner officer member guest roles allowance rooms',
    facts: [
      {
        title: 'Give each role a purpose',
        copy: 'Owners are multisig members. Officers coordinate the workspace. Members use their assigned allowance. Guests have limited access. Production authorization must enforce these boundaries on the server.',
      },
      {
        title: 'Make the budget explicit',
        copy: 'The plan calls for a revocable Squads spending limit, daily usage settlement, and per-member caps. Chapters are proposed at 9 USDC per member each month, plus usage.',
      },
      {
        title: 'Helpers draft. People decide.',
        copy: 'Helpers receive a rulebook and an allowance. They may draft or simulate proposals, but never sign or execute them. Encrypted rooms need device keys and key rotation when membership changes.',
      },
    ],
  },
  {
    id: 'integrations',
    number: '06',
    name: 'Beyond the browser',
    subtitle: 'Take the room with you.',
    introduction:
      'Conclave’s web experience is the starting point. The roadmap also includes native mobile, Telegram and developer surfaces. Their production connections are still required.',
    keywords:
      'mcp api telegram seeker android ios developer oauth wallet passkey',
    facts: [
      {
        title: 'MCP & API',
        copy: 'The planned MCP tools are conclave_ask, conclave_compare, conclave_crosscheck and conclave_explain_tx. Each needs OAuth, revocation and spending caps. The initial API contract is chat completions only.',
      },
      {
        title: 'Mobile & Telegram',
        copy: 'Android/Seeker uses Mobile Wallet Adapter; iOS uses passkeys and wallet deep links. Telegram is planned around /ask, /check, /explain and /balance. No app-store release is implied by this website.',
      },
      {
        title: 'Wallets are not accounts alone',
        copy: "A connected address is not proof of ownership. Production sign-in requires a nonce-bound, domain-bound signature or verified passkey ceremony, then a server session. A wallet that offers Sign In With Solana must use it, so the wallet itself checks which site is asking; signing the exact sign-in text is accepted only from wallets without that feature, and every signed field is compared with the server's challenge.",
      },
    ],
  },
];

const routeExamples = {
  local: {
    name: 'Local companion',
    level: 'LOCAL',
    visibility: 'Runs on your device',
    retention: 'Controlled by your local runtime',
    training: 'Check your installed runtime',
    jurisdiction: 'Your device',
    evidence: 'Requires a connected local companion',
    color: 'local',
  },
  frontier: {
    name: 'Frontier provider',
    level: 'UNVERIFIED',
    visibility: 'Provider can read your prompt',
    retention: 'Not verified',
    training: 'Not verified',
    jurisdiction: 'Not verified',
    evidence: 'Dated vendor evidence required',
    color: 'unverified',
  },
  sealed: {
    name: 'Sanctum route',
    level: 'E2EE_TO_SEALED',
    visibility: 'Encrypted to a sealed host',
    retention: 'Subject to the verified host policy',
    training: 'Subject to the verified host policy',
    jurisdiction: 'Must be declared by host',
    evidence: 'Valid attestation required before sending',
    color: 'sealed',
  },
};

function RouteInspector() {
  const t = useT();
  const [selected, setSelected] =
    useState<keyof typeof routeExamples>('frontier');
  const [showContract, setShowContract] = useState(false);
  const route = routeExamples[selected];
  return (
    <section
      className="field-interactive"
      aria-label={t('Illustrative Route Card inspector')}
    >
      <div className="field-interactive-top">
        <span className="field-micro">{t('INTERACTIVE / ROUTE CARD')}</span>
        <span className="field-tag">{t('ILLUSTRATIVE')}</span>
      </div>
      <fieldset className="field-route-tabs" aria-label={t('Route example')}>
        {Object.entries(routeExamples).map(([key, example]) => (
          <button
            key={key}
            className={selected === key ? 'is-selected' : ''}
            aria-pressed={selected === key}
            onClick={() => setSelected(key as keyof typeof routeExamples)}
          >
            {t(example.name)}
          </button>
        ))}
      </fieldset>
      <div className={`field-route-card field-route-card--${route.color}`}>
        <div className="field-route-heading">
          <ShieldCheck size={27} strokeWidth={1.2} />
          <span>{t(route.name)}</span>
          <span className="field-route-star" aria-hidden="true">
            ✦
          </span>
        </div>
        <span className="field-route-level">
          {t(route.level.replaceAll('_', ' '))}
        </span>
        <dl>
          <div>
            <dt>{t('Content visibility')}</dt>
            <dd>{t(route.visibility)}</dd>
          </div>
          <div>
            <dt>{t('Retention')}</dt>
            <dd>{t(route.retention)}</dd>
          </div>
          <div>
            <dt>{t('Training use')}</dt>
            <dd>{t(route.training)}</dd>
          </div>
          <div>
            <dt>{t('Jurisdiction')}</dt>
            <dd>{t(route.jurisdiction)}</dd>
          </div>
          <div>
            <dt>{t('Evidence')}</dt>
            <dd>{t(route.evidence)}</dd>
          </div>
        </dl>
        <p className="field-route-note">
          {t(
            'Example card only. No provider or sealed host has been verified in this local preview.',
          )}
        </p>
      </div>
      <button
        className="field-contract-toggle"
        aria-expanded={showContract}
        onClick={() => setShowContract(!showContract)}
      >
        <Code2 size={16} /> {t('Inspect the required card fields')}{' '}
        <ChevronDown size={16} className={showContract ? 'is-rotated' : ''} />
      </button>
      {showContract && (
        <pre className="field-code">{`{\n  route_id, model, provider, level,\n  retention_days, training_use, jurisdiction,\n  legal_hold_flag, evidence_url, evidence_date,\n  last_verified_at\n}`}</pre>
      )}
    </section>
  );
}

const guardScenarios = [
  {
    label: 'Normal request',
    text: 'Compare these two public project proposals.',
    state: 'Ready for review',
    detail:
      'No demonstration marker found. This does not certify arbitrary text as safe.',
    icon: 'check',
  },
  {
    label: 'Synthetic key',
    text: 'Please store this: [SYNTHETIC_PRIVATE_KEY]',
    state: 'Send blocked',
    detail:
      'The harmless demo marker is blocked locally. Nothing is sent or saved.',
    icon: 'block',
  },
  {
    label: 'Synthetic API secret',
    text: 'The test config is API_KEY=[SYNTHETIC_SECRET]',
    state: 'Secret redacted',
    detail: 'The demonstration secret is replaced before the preview is built.',
    icon: 'redact',
  },
];

function GuardSandbox() {
  const t = useT();
  const [index, setIndex] = useState(1);
  const [checked, setChecked] = useState(false);
  const scenario = guardScenarios[index];
  return (
    <section
      className="field-interactive"
      aria-label={t('Synthetic guard demonstration')}
    >
      <div className="field-interactive-top">
        <span className="field-micro">{t('TRY THE THRESHOLD')}</span>
        <span className="field-tag">{t('ON THIS DEVICE')}</span>
      </div>
      <h3 className="field-tool-title">
        {t.rich('Some things should{break}{emphasis}', {
          break: <br />,
          emphasis: <em>{t('never leave the room.')}</em>,
        })}
      </h3>
      <p className="field-tool-copy">
        {t(
          'Select a harmless example. This sandbox illustrates the flow; it is not the production key detector.',
        )}
      </p>
      <fieldset
        className="field-scenario-tabs"
        aria-label={t('Synthetic examples')}
      >
        {guardScenarios.map((item, i) => (
          <button
            key={item.label}
            className={index === i ? 'is-selected' : ''}
            aria-pressed={index === i}
            onClick={() => {
              setIndex(i);
              setChecked(false);
            }}
          >
            {t(item.label)}
          </button>
        ))}
      </fieldset>
      <div className="field-prompt-preview">
        <span className="field-micro">{t('SYNTHETIC INPUT')}</span>
        <code>{t(scenario.text)}</code>
      </div>
      <button className="field-primary-button" onClick={() => setChecked(true)}>
        {t('Run the local example')} <ArrowRight size={16} />
      </button>
      <output
        className={`field-guard-result ${checked ? 'is-checked' : ''}`}
        aria-live="polite"
      >
        {checked ? (
          <>
            <span className="field-result-icon">
              {scenario.icon === 'block' ? (
                <X size={21} />
              ) : (
                <Check size={21} />
              )}
            </span>
            <span>
              <strong>{t(scenario.state)}</strong>
              <span className="field-result-copy">{t(scenario.detail)}</span>
              {index === 2 && <code>API_KEY=[REDACTED]</code>}
            </span>
          </>
        ) : (
          <span>
            {t('No network request. No storage. Synthetic examples only.')}
          </span>
        )}
      </output>
    </section>
  );
}

function BillingCalculator() {
  const t = useT();
  const [cost, setCost] = useState('1.00');
  const [sanctum, setSanctum] = useState(false);
  const base = Math.max(0, Math.min(100000, Number(cost) || 0));
  const margin = base * (sanctum ? 0.15 : 0.05);
  return (
    <section
      className="field-interactive field-billing"
      aria-label={t('Illustrative usage calculator')}
    >
      <div className="field-interactive-top">
        <span className="field-micro">{t('SHOW YOUR WORK')}</span>
        <span className="field-tag">{t('PRICING EXAMPLE')}</span>
      </div>
      <h3 className="field-tool-title">
        {t.rich('Small margin.{break}{emphasis}', {
          break: <br />,
          emphasis: <em>{t('Visible arithmetic.')}</em>,
        })}
      </h3>
      <label className="field-cost-label" htmlFor="provider-cost">
        {t('Example provider cost (USDC)')}
      </label>
      <input
        id="provider-cost"
        type="number"
        min="0"
        max="100000"
        step="0.01"
        value={cost}
        onChange={(event) => setCost(event.target.value)}
      />
      <div className="field-route-tabs">
        <button
          className={!sanctum ? 'is-selected' : ''}
          aria-pressed={!sanctum}
          onClick={() => setSanctum(false)}
        >
          {t('Standard · 5%')}
        </button>
        <button
          className={sanctum ? 'is-selected' : ''}
          aria-pressed={sanctum}
          onClick={() => setSanctum(true)}
        >
          {t('Sanctum · 15%')}
        </button>
      </div>
      <dl className="field-calculation">
        <div>
          <dt>{t('Provider cost')}</dt>
          <dd>{base.toFixed(4)}</dd>
        </div>
        <div>
          <dt>{t('Conclave margin')}</dt>
          <dd>+ {margin.toFixed(4)}</dd>
        </div>
        <div>
          <dt>{t('Illustrative total')}</dt>
          <dd>
            {(base + margin).toFixed(4)} <small>USDC</small>
          </dd>
        </div>
      </dl>
      <p className="field-route-note">
        {t(
          'Based on proposed pricing terms. This is not a live quote, charge or deposit interface.',
        )}
      </p>
    </section>
  );
}

function ConsensusGuide() {
  const t = useT();
  const [selected, setSelected] = useState(3);
  const results = [
    {
      name: 'HOLDS',
      text: 'All valid independent reviews support a claim with exact source quotes.',
    },
    {
      name: 'DOESN’T HOLD',
      text: 'All valid independent reviews contradict a claim with exact source quotes.',
    },
    {
      name: 'PARTLY',
      text: 'At answer level, some claims hold and others do not. Open the claim-by-claim result.',
    },
    {
      name: 'NO CONSENSUS',
      text: 'Reviews disagree, evidence is insufficient, or a definite answer cannot be established. The uncertainty stays visible.',
    },
  ];
  return (
    <section className="field-interactive">
      <div className="field-interactive-top">
        <span className="field-micro">{t('THE LANGUAGE OF A CHECK')}</span>
        <span className="field-tag">{t('FOUR OUTCOMES')}</span>
      </div>
      <div className="field-outcomes">
        {results.map((result, index) => (
          <button
            key={result.name}
            onClick={() => setSelected(index)}
            aria-pressed={selected === index}
            className={selected === index ? 'is-selected' : ''}
          >
            <span>0{index + 1}</span>
            {t(result.name)}
            <ArrowRight size={15} />
          </button>
        ))}
      </div>
      <output className="field-outcome-detail" aria-live="polite">
        <span aria-hidden="true">✳</span>
        <span className="field-outcome-copy">{t(results[selected].text)}</span>
      </output>
      <p className="field-route-note">
        {t(
          'A shared mistake is possible even when every model agrees. Cross-Check reports evidence and model views, not certainty.',
        )}
      </p>
    </section>
  );
}

function IntegrationStatus({ chapter = false }: { chapter?: boolean }) {
  const t = useT();
  const rows = chapter
    ? [
        'Squads ownership & spending limits',
        'Server-enforced member permissions',
        'Device keys & room key rotation',
        'Signed monthly usage statements',
      ]
    : [
        'Wallet & passkey authentication',
        'Paid model gateway & source retrieval',
        'Sealed hosts & cryptographic receipts',
        'MCP, Telegram & native mobile',
      ];
  return (
    <section className="field-interactive">
      <div className="field-interactive-top">
        <span className="field-micro">{t('CONNECTION REGISTER')}</span>
        <span className="field-tag">{t('LOCAL PREVIEW')}</span>
      </div>
      <h3 className="field-tool-title">
        {t.rich('The interface is here.{break}{emphasis}', {
          break: <br />,
          emphasis: <em>{t('The connections come next.')}</em>,
        })}
      </h3>
      <div className="field-status-list">
        {rows.map((row) => (
          <div key={row}>
            <span>{t(row)}</span>
            <span>{t('INTEGRATION REQUIRED')}</span>
          </div>
        ))}
      </div>
      <p className="field-route-note">
        {t(
          'The workspace uses clearly labelled sample behavior and browser-local state. It does not connect to these production services.',
        )}
      </p>
      <Link className="field-text-link" href="/dashboard">
        {t('Explore the workspace preview')} <ArrowRight size={16} />
      </Link>
    </section>
  );
}

export default function DocumentationPage() {
  const t = useT();
  const [active, setActive] = useState<TopicId>('routes');
  const [query, setQuery] = useState('');
  const filtered = topics.filter((topic) => {
    const english = `${topic.name} ${topic.subtitle} ${topic.keywords} ${topic.introduction}`;
    const chinese =
      t.locale === 'zh'
        ? [
            t(topic.name),
            t(topic.subtitle),
            t(topic.introduction),
            ...topic.facts.flatMap((fact) => [t(fact.title), t(fact.copy)]),
          ].join(' ')
        : '';
    return (
      english.toLowerCase().includes(query.toLowerCase()) ||
      (t.locale === 'zh' && chinese.toLowerCase().includes(query.toLowerCase()))
    );
  });
  const topic = topics.find((item) => item.id === active)!;
  useEffect(() => {
    function syncTopic() {
      const hash = window.location.hash.slice(1);
      const id = !hash
        ? 'routes'
        : hash === 'developers'
          ? 'integrations'
          : hash;
      if (topics.some((item) => item.id === id)) {
        setActive(id as TopicId);
        if (hash)
          window.requestAnimationFrame(() =>
            document
              .getElementById('field-article')
              ?.scrollIntoView({ behavior: 'instant', block: 'start' }),
          );
      }
    }
    syncTopic();
    window.addEventListener('hashchange', syncTopic);
    window.addEventListener('popstate', syncTopic);
    return () => {
      window.removeEventListener('hashchange', syncTopic);
      window.removeEventListener('popstate', syncTopic);
    };
  }, []);
  function chooseTopic(id: TopicId) {
    setActive(id);
    window.history.pushState(null, '', `#${id}`);
    document.getElementById('field-article')?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'start',
    });
  }
  return (
    <main className="field-guide" id="field-guide">
      <nav className="field-nav" aria-label={t('Documentation navigation')}>
        <Link className="field-brand" href="/" aria-label={t('Conclave home')}>
          <HorseMark className="field-brand-horse" />
          <Wordmark className="field-brand-name" />
          <sup>®</sup>
        </Link>
        <div>
          <LanguageToggle className="field-language" />
          <Link href="/">{t('The experience')}</Link>
          <Link href="/dashboard">
            {t('Workspace')} <ArrowUpRightIcon />
          </Link>
        </div>
      </nav>
      <header className="field-hero">
        <div className="field-hero-line">
          <span>{t('THE CONCLAVE FIELD GUIDE')}</span>
          <span>{t('VOL. 001 / AN OPEN BOOK')}</span>
        </div>
        <div className="field-hero-copy">
          <h1>
            {t.rich('Know {room}', {
              room: <em>{t('the room.')}</em>,
            })}
          </h1>
          <p>
            {t('How the models meet.')}
            <br /> {t('Where your words travel.')}
            <br /> {t('What stays in your hands.')}
          </p>
        </div>
        <div className="field-banner">
          <Image
            src="/brand/conclave-framed-banner-3x1-v3.png"
            width={1536}
            height={512}
            unoptimized
            alt={t(
              'An ornate scarlet Conclave banner with engraved floral borders',
            )}
          />
          <div className="field-banner-bottom">
            <span>{t('INDEPENDENT MINDS. INFORMED DECISIONS.')}</span>
            <a href="#field-content" aria-label={t('Read the field guide')}>
              <ArrowDown size={22} />
            </a>
          </div>
        </div>
      </header>
      <div className="field-content" id="field-content">
        <aside className="field-sidebar">
          <label className="field-search">
            <Search size={17} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Find your subject')}
              aria-label={t('Search documentation topics')}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label={t('Clear search')}
              >
                <X size={14} />
              </button>
            )}
          </label>
          <span className="field-micro field-index-label">
            {t('IN THIS VOLUME / {count} SUBJECTS', { count: filtered.length })}
          </span>
          <nav aria-label={t('Field guide topics')}>
            {filtered.map((item) => (
              <button
                key={item.id}
                onClick={() => chooseTopic(item.id)}
                className={active === item.id ? 'is-active' : ''}
                aria-current={active === item.id ? 'page' : undefined}
              >
                <span>{item.number}</span>
                {t(item.name)}
                <ArrowRight size={14} />
              </button>
            ))}
            {!filtered.length && (
              <p className="field-no-results">
                {t('No subjects found. Try “privacy”, “cost”, or “models”.')}
              </p>
            )}
          </nav>
          <div className="field-margin-note">
            <span aria-hidden="true">✦</span>
            <p>{t('A label is only as useful as the evidence behind it.')}</p>
            <span className="field-micro">{t('A NOTE FROM THE ROOM')}</span>
          </div>
        </aside>
        <article className="field-article" id="field-article" key={active}>
          <div className="field-article-kicker">
            <span className="field-micro">
              {t('CHAPTER {number}', { number: topic.number })}
            </span>
            <span className="field-micro">{t('CONCLAVE / EXPLAINED')}</span>
          </div>
          <h2>{t(topic.subtitle)}</h2>
          <p className="field-introduction">{t(topic.introduction)}</p>
          <div className="field-facts">
            {topic.facts.map((fact, i) => (
              <div key={fact.title}>
                <span className="field-fact-number">
                  {topic.number}.{i + 1}
                </span>
                <div>
                  <h3>{t(fact.title)}</h3>
                  <p>{t(fact.copy)}</p>
                </div>
              </div>
            ))}
          </div>
          {active === 'routes' && <RouteInspector />}
          {active === 'guards' && <GuardSandbox />}
          {active === 'billing' && <BillingCalculator />}
          {active === 'compare' && <ConsensusGuide />}
          {(active === 'chapters' || active === 'integrations') && (
            <IntegrationStatus chapter={active === 'chapters'} />
          )}
          <div className="field-article-footer">
            <span className="field-micro">{t('YOUR NEXT PAGE')}</span>
            <button
              onClick={() =>
                chooseTopic(
                  topics[
                    (topics.findIndex((item) => item.id === active) + 1) %
                      topics.length
                  ].id,
                )
              }
            >
              {t(
                topics[
                  (topics.findIndex((item) => item.id === active) + 1) %
                    topics.length
                ].name,
              )}
              <ArrowRight size={19} />
            </button>
          </div>
        </article>
      </div>
      <section className="field-closing">
        <span className="field-micro">{t('THE DOOR IS OPEN')}</span>
        <h2>
          {t.rich('Less blind trust.{break}{emphasis}', {
            break: <br />,
            emphasis: <em>{t('More room to think.')}</em>,
          })}
        </h2>
        <Link href="/dashboard">
          {t('Enter the workspace')} <ArrowRight size={20} />
        </Link>
        <p>{t('Local product preview. Explore with sample data.')}</p>
      </section>
      <footer className="field-footer">
        <Link href="/">
          <ArrowLeft size={14} /> {t('Back to Conclave')}
        </Link>
        <span>{t('EVERY MODEL. ONE ROOM.')}</span>
        <a href="#field-guide">{t('BACK TO TOP ↑')}</a>
      </footer>
    </main>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3 13 13 3M3 3h10v10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
