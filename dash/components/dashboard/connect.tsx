'use client';

// Update 05 "Pair my coding tool" (/dashboard/connect). The person picks Cursor or Claude Code, copies a setup that
// reads the key from an environment variable on their computer, runs one test prompt in the tool and pastes back the
// receipt id. The page never calls /mcp, never shows or copies the key (only KEY_PLACEHOLDER), and says "Confirmed"
// only when the owner lookup proves an MCP call with this key, made after the test started, with the test's model.

import Link from 'next/link';
import { Box, Check, CircleAlert, Link2, SquareTerminal, Terminal } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { MaskGlyph } from '../brand';
import { CopyButton } from '../copy-button';
import { useAnonymo } from '../anonymo-provider';
import { AnonymoApiError } from '@/lib/anonymo/client';
import { publicApiBase } from '@/lib/anonymo/config';
import {
  UNCONFIRMED_TEXT,
  checkReceipt,
  diagnosePaste,
  loadAttempt,
  receiptIdIn,
  saveAttempt,
  testModels,
  testPrompt,
  type CodingClientId,
  type ConnectAttempt,
  type ReceiptCheck,
  type Recovery,
} from '@/lib/anonymo/connect';
import { MCP_CLIENTS, mcpEndpoint, mcpSetupText } from '@/lib/anonymo/presets';
import { isMobileBrowser } from '@/lib/anonymo/wallet-links';
import './connect.css';

type Outcome =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'checked'; result: ReceiptCheck }
  | { kind: 'not-found' }
  | { kind: 'no-id' }
  | { kind: 'unreachable' };

type RecoveryState = { kind: Recovery; from: 'dashboard' | 'tool' };

const session = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

export function ConnectView() {
  const { ready, demo, key, client, catalog, catalogError, refreshCatalog, balanceVersion } = useAnonymo();
  // The test survives switching to the tool and back (this tab only); the tool and model choices follow it. Read once
  // the page is hydrated; anything the person picks afterwards wins (undefined = nothing picked yet).
  const stored = useMemo(() => (ready ? loadAttempt(session()) : null), [ready]);
  const [pickedClient, setClientId] = useState<CodingClientId | undefined>(undefined);
  const [pickedModel, setPickedModel] = useState<string | null | undefined>(undefined);
  const [startedAttempt, setAttempt] = useState<ConnectAttempt | null | undefined>(undefined);
  const clientId = pickedClient ?? stored?.client ?? 'cursor';
  const attempt = startedAttempt === undefined ? stored : startedAttempt;
  const [pasted, setPasted] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [toolProblem, setToolProblem] = useState<Recovery | null>(null);
  const [balance, setBalance] = useState<{ key: string; usd: number | null } | null>(null);
  const phone = ready && isMobileBrowser();
  const resultRef = useRef<HTMLOutputElement>(null);
  const ids = useId();

  // Credit for the test call, read with the key held on this device. Unknown (null) never blocks.
  useEffect(() => {
    if (!ready || !key) return;
    const abort = new AbortController();
    client.balance(abort.signal).then(
      (b) => {
        const usd = Number(b.available_usd);
        setBalance({ key, usd: Number.isFinite(usd) ? usd : null });
      },
      () => setBalance({ key, usd: null }),
    );
    return () => abort.abort();
  }, [ready, key, client, balanceVersion]);
  const available = ready && key && balance?.key === key ? balance.usd : null;

  const tool = MCP_CLIENTS.find((c) => c.id === clientId) ?? MCP_CLIENTS[0];
  const base = publicApiBase(demo);
  const models = useMemo(() => testModels(catalog), [catalog]);
  const wanted = pickedModel === undefined ? stored?.model : pickedModel;
  const model = wanted && models.includes(wanted) ? wanted : (models[0] ?? null);
  const steps = tool.steps(base);
  const prompt = model ? testPrompt(model) : '';
  const attemptMatches = attempt !== null && attempt.client === clientId && attempt.model === model;

  // Problems the dashboard can see, the most basic first; shown at the top, before the setup.
  const dashRecovery: RecoveryState | null =
    ready && !key ? { kind: 'missing_credential', from: 'dashboard' }
    : catalog !== null && models.length === 0 ? { kind: 'unavailable_model', from: 'dashboard' }
    : catalogError && catalog === null ? { kind: 'unavailable_model', from: 'dashboard' }
    : available !== null && available <= 0 ? { kind: 'insufficient_funds', from: 'dashboard' }
    : null;
  // A problem read from the tool's pasted error: shown where it was pasted.
  const toolRecovery: RecoveryState | null = toolProblem && dashRecovery?.kind !== toolProblem ? { kind: toolProblem, from: 'tool' } : null;
  const retryModel = () => {
    setPickedModel(null);
    setToolProblem(null);
    refreshCatalog();
  };

  const startTest = () => {
    if (!model) return;
    const next = { client: clientId, model, startedAt: Date.now() };
    setAttempt(next);
    saveAttempt(session(), next);
    setOutcome({ kind: 'idle' });
    setToolProblem(null);
    setPasted('');
  };

  const check = useCallback(async () => {
    if (!attempt) return;
    const id = receiptIdIn(pasted);
    if (!id) {
      const problem = diagnosePaste(pasted);
      setToolProblem(problem);
      setOutcome(problem ? { kind: 'idle' } : { kind: 'no-id' });
      return;
    }
    setToolProblem(null);
    setOutcome({ kind: 'checking' });
    try {
      const sentAt = Date.now();
      const generation = await client.generation(id);
      setOutcome({ kind: 'checked', result: checkReceipt(attempt, generation, { sentAt, receivedAt: Date.now() }) });
    } catch (error) {
      if (error instanceof AnonymoApiError && error.status === 401) {
        setOutcome({ kind: 'idle' });
        setToolProblem('missing_credential');
      } else if (error instanceof AnonymoApiError && error.status === 404) setOutcome({ kind: 'not-found' });
      else setOutcome({ kind: 'unreachable' });
    }
  }, [attempt, pasted, client]);

  useEffect(() => {
    if ((outcome.kind !== 'idle' && outcome.kind !== 'checking') || toolProblem) resultRef.current?.focus();
  }, [outcome, toolProblem]);

  const ToolIcon = clientId === 'cursor' ? Box : SquareTerminal;
  const confirmed = outcome.kind === 'checked' && outcome.result.status === 'confirmed';

  return (
    <div className="panel-stack cn">
      <section className="panel cn-pair" aria-labelledby={`${ids}-pair`}>
        <h2 id={`${ids}-pair`} className="sr-only">Link your tool</h2>
        <label className="field cn-label">
          <span className="cn-eyebrow">Coding tool</span>
          <select
            className="select cn-select"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value as CodingClientId);
              setToolProblem(null);
            }}
          >
            {MCP_CLIENTS.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>

        <div className="cn-link" aria-hidden="true">
          <span className="cn-node"><ToolIcon size={26} strokeWidth={1.6} /></span>
          <span className="cn-dots" />
          <Link2 size={20} className={confirmed ? 'cn-linked' : undefined} />
          <span className="cn-dots" />
          <span className="cn-node cn-node-brand"><MaskGlyph size={44} /></span>
        </div>

        <ol className="cn-steps">
          <li data-done={attempt ? 'true' : undefined}>
            <span className="cn-step-mark">{attempt ? <Check size={14} aria-hidden="true" /> : '1'}</span>
            <div>
              <strong>Link to Anonymo</strong>
              <span className="muted">
                {attempt ? `Setup ready. Add it in ${tool.name} if you have not yet.` : `Add the setup below in ${tool.name} on your computer.`}
              </span>
            </div>
          </li>
          <li data-done={confirmed ? 'true' : undefined}>
            <span className="cn-step-mark">{confirmed ? <Check size={14} aria-hidden="true" /> : '2'}</span>
            <div>
              <strong>Test the connection</strong>
              <span className="muted">Run a first prompt through the tool, then paste its receipt here.</span>
            </div>
          </li>
        </ol>
      </section>

      {dashRecovery && <RecoveryPanel recovery={dashRecovery} toolName={tool.name} onRetryModel={retryModel} onDismiss={() => setToolProblem(null)} />}

      <section className="panel cn-setup" aria-labelledby={`${ids}-setup`}>
        <header>
          <h2 id={`${ids}-setup`}>Setup for {tool.name}</h2>
          <span className="chip chip-signal cn-ready"><Check size={12} aria-hidden="true" /> Setup ready</span>
        </header>
        <p className="muted cn-small">
          Your key is never part of this setup. {tool.name} reads it from <code>ANONYMO_API_KEY</code> on your computer.
          Server: <code className="cn-wrap">{mcpEndpoint(base)}</code> · {tool.transport}
        </p>
        {phone && (
          <div className="notice cn-phone">
            <p>Finish this on your computer: {tool.name} runs there, not on this phone.</p>
            <CopyButton text={mcpSetupText(tool, base)} label="Copy setup for my computer" className="btn-primary" />
          </div>
        )}
        <ol className="cn-setup-steps">
          {steps.map((step) => (
            <li key={step.label}>
              <div className="cn-step-head">
                <span>{step.label}</span>
                <CopyButton text={step.text} label={step.language === 'json' ? 'Copy JSON' : 'Copy'} />
              </div>
              <pre className="snippet cn-snippet"><code>{step.text}</code></pre>
              {step.note && <p className="faint cn-small">{step.note}</p>}
            </li>
          ))}
          <li>
            <div className="cn-step-head"><span>Start {tool.name}</span></div>
            <p className="faint cn-small">{tool.start}</p>
          </li>
        </ol>
        {!phone && <CopyButton text={mcpSetupText(tool, base)} label="Copy whole setup" />}
        {demo && <p className="notice notice-amber cn-small">Demo mode: the server address is a placeholder until the gateway is live.</p>}
      </section>

      <section className="panel cn-test" aria-labelledby={`${ids}-test`}>
        <h2 id={`${ids}-test`} className="cn-eyebrow">Connection test</h2>
        <label className="field">
          Test model
          <select className="select" value={model ?? ''} disabled={!models.length} onChange={(e) => setPickedModel(e.target.value)}>
            {models.length === 0 && <option value="">No live model</option>}
            {models.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
        <div className="cn-term">
          <code className="cn-term-cmd">$ {clientId === 'cursor' ? 'cursor' : 'claude'}</code>
          <code className="cn-term-ask">{model ? prompt : 'Waiting for a live model.'}</code>
          <code className="cn-term-state">
            ›{' '}
            {outcome.kind === 'checking' ? 'Checking receipt' : confirmed ? 'Receipt confirmed' : attemptMatches ? 'Awaiting test request' : 'Not started'}
          </code>
        </div>
        <div className="row">
          {model && <CopyButton text={prompt} label="Copy test prompt" />}
        </div>
        <button type="button" className="btn btn-primary cn-run" disabled={!model} onClick={startTest}>
          <Terminal size={16} aria-hidden="true" />
          {attemptMatches ? 'Start a new test' : 'Run test request'}
        </button>
        {attemptMatches && (
          <p className="faint cn-small">
            Test started {new Date(attempt!.startedAt).toLocaleTimeString()}. Paste the prompt into {tool.name}, then paste what it answers below.
          </p>
        )}

        {attemptMatches && (
          <form
            className="cn-receipt"
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <label className="field">
              Receipt from {tool.name}
              <textarea
                className="textarea"
                rows={3}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="gen-… or the whole reply"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <button type="submit" className="btn" disabled={!pasted.trim() || outcome.kind === 'checking' || !key}>
              Check receipt
            </button>
          </form>
        )}

        <output ref={resultRef} tabIndex={-1} aria-live="polite" className="cn-result-wrap">
          {toolRecovery && <RecoveryPanel recovery={toolRecovery} toolName={tool.name} onRetryModel={retryModel} onDismiss={() => setToolProblem(null)} />}
          {outcome.kind === 'checked' && <ResultCard result={outcome.result} toolName={tool.name} />}
          {outcome.kind === 'not-found' && (
            <Unconfirmed toolName={tool.name} lines={['The key on this device cannot see that receipt. It was made with a different key, or the id is mistyped.']} />
          )}
          {outcome.kind === 'no-id' && (
            <Unconfirmed toolName={tool.name} lines={['There is no receipt id in what you pasted. It starts with gen- and is in the chat tool’s reply.']} />
          )}
          {outcome.kind === 'unreachable' && <Unconfirmed toolName={tool.name} lines={['The gateway could not be reached to check the receipt. Try again in a moment.']} />}
        </output>
      </section>
    </div>
  );
}

function ResultCard({ result, toolName }: { result: ReceiptCheck; toolName: string }) {
  const g = result.generation;
  if (result.status === 'unconfirmed') return <Unconfirmed toolName={toolName} lines={result.reasons.map((r) => UNCONFIRMED_TEXT[r])} receipt={g.id} />;
  return (
    <div className="cn-result cn-result-ok">
      <p className="cn-result-title"><Check size={16} aria-hidden="true" /> Confirmed from your coding tool</p>
      <dl className="kv cn-kv">
        <dt>Receipt</dt>
        <dd className="cn-wrap">{g.id}</dd>
        <dt>Came in through</dt>
        <dd>Anonymo MCP, with your key</dd>
        <dt>Model</dt>
        <dd className="cn-wrap">{g.model}</dd>
        <dt>Made</dt>
        <dd>{new Date(g.created_at).toLocaleTimeString()}</dd>
        {typeof g.total_cost === 'number' && (
          <>
            <dt>Cost</dt>
            <dd>${g.total_cost.toFixed(6)}</dd>
          </>
        )}
      </dl>
      <p className="faint cn-small">
        The receipt proves this call came through Anonymo’s MCP server with your key, after you started the test. A receipt cannot
        name the program that sent it: {toolName}’s own reply showing this receipt id is what shows it was {toolName}.
      </p>
    </div>
  );
}

function Unconfirmed({ lines, toolName, receipt }: { lines: string[]; toolName: string; receipt?: string }) {
  return (
    <div className="cn-result cn-result-warn">
      <p className="cn-result-title"><CircleAlert size={16} aria-hidden="true" /> Unconfirmed</p>
      {receipt && <p className="faint cn-small cn-wrap">Receipt {receipt}</p>}
      <ul className="cn-reasons">
        {lines.map((l) => <li key={l}>{l}</li>)}
      </ul>
      <p className="faint cn-small">Check the reply in {toolName}, then paste the receipt id from this test, or start a new test.</p>
    </div>
  );
}

const RECOVERY: Record<Recovery, { title: string; body: (tool: string, from: 'dashboard' | 'tool') => string }> = {
  missing_credential: {
    title: 'Key missing',
    body: (tool, from) =>
      from === 'dashboard'
        ? 'Add your key on this device so the dashboard can check the test receipt. The setup itself never needs it here.'
        : `${tool} reached Anonymo without a working key. Set ANONYMO_API_KEY in your shell, then start ${tool} again from that shell.`,
  },
  insufficient_funds: {
    title: 'Not enough credit',
    body: () => 'The test call is billed like any chat. Add funds, then run the test again.',
  },
  unavailable_model: {
    title: 'Test model unavailable',
    body: (_tool, from) =>
      from === 'tool' ? 'That model is not live right now, so nothing was charged. Pick another model and start a new test.' : 'No live model can take the test right now. Check again in a moment.',
  },
  unsupported_config: {
    title: 'Setup not supported',
    body: (tool) =>
      `${tool} could not use this setup. The server address must end in /mcp and use HTTP, not SSE or a local command. Update ${tool} if it has no HTTP MCP support, then copy the setup again.`,
  },
};

function RecoveryPanel({ recovery, toolName, onRetryModel, onDismiss }: { recovery: RecoveryState; toolName: string; onRetryModel: () => void; onDismiss: () => void }) {
  const copy = RECOVERY[recovery.kind];
  const titleId = `${useId()}-recovery`;
  return (
    <section className="notice notice-rose cn-recovery" aria-labelledby={titleId} data-recovery={recovery.kind}>
      <h2 id={titleId} className="cn-result-title"><CircleAlert size={16} aria-hidden="true" /> {copy.title}</h2>
      <p>{copy.body(toolName, recovery.from)}</p>
      <div className="row">
        {recovery.kind === 'missing_credential' && recovery.from === 'dashboard' && <Link className="btn btn-primary btn-small" href="/dashboard/key">Add your key</Link>}
        {recovery.kind === 'insufficient_funds' && <Link className="btn btn-primary btn-small" href="/dashboard/funds">Add funds</Link>}
        {recovery.kind === 'unavailable_model' && <button type="button" className="btn btn-primary btn-small" onClick={onRetryModel}>Pick another model</button>}
        {recovery.from === 'tool' && <button type="button" className="btn btn-small" onClick={onDismiss}>Dismiss</button>}
      </div>
    </section>
  );
}
