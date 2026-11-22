'use client';

// Update "ventures": the launcher. Pick one of four modes, fill the brief, see the all-in price before anything is
// spent, and start the crew. Below: this key's runs, the Recipes others saved (run one with a click), and the key's
// tier with what it unlocks. Prices and checks come from lib/anonymo/ventures.ts, which mirrors the gateway.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, Crown, FlaskConical, GitFork, Info, Lightbulb, Loader2, Lock, Repeat2, Rocket, Sparkles, Swords, Target, X } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Mo } from './mo';
import { useVenturesClient } from './ventures-client';
import { describeError, isOutOfCredit, type AnonymoClient } from '@/lib/anonymo/client';
import {
  CREW,
  EMPTY_BRIEF,
  LINEUP,
  MODES,
  NYMO_DISCOUNT_PCT,
  TIERS,
  TIER_RULES,
  briefProblem,
  createBody,
  modeInfo,
  modeTitle,
  nymoPrice,
  priceLine,
  relTime,
  statusLabel,
  statusTone,
  tierAllows,
  tierFor,
  tierLabel,
  tierPerks,
  RECIPE_MAKER_SHARE,
  usd,
  type BriefForm,
  type ModeInfo,
  type Recipe,
  type TierInfo,
  type VentureMode,
  type VentureSummary,
} from '@/lib/anonymo/ventures';
import './ventures.css';

const MODE_ICONS: Record<string, typeof Rocket> = { IDEA_TO_LIVE: Lightbulb, BUILD_BETTER: Target, TAKEOVER: Swords, FORK_FLIP: GitFork, DUPE_DROP: Sparkles };

/** Made-up businesses for "Use a sample" (every address is an .example host). */
const SAMPLES: Record<string, Partial<BriefForm>> = {
  IDEA_TO_LIVE: { brief: 'Plant-care reminders for renters with too many houseplants: one photo per plant, a nudge on the right day.', brand: 'Leaflog' },
  BUILD_BETTER: { target_url: 'https://slotharbor.example', brief: 'A calmer booking tool for small studios, with waitlists and deposits.', brand: 'Quayside' },
  TAKEOVER: { target_url: 'https://invoicemule.example', rival: 'InvoiceMule', brand: 'Ledgerlark' },
  FORK_FLIP: { repo_url: 'https://git.example/sample/notes-lite', brief: 'Keep it local-first and add sync people host themselves.', brand: 'Quillpad' },
};

export function VenturesLauncher() {
  const { client, ready, sample, addDemoCredit } = useVenturesClient();
  const router = useRouter();
  const [mode, setMode] = useState<VentureMode>('BUILD_BETTER');
  const [form, setForm] = useState<BriefForm>(EMPTY_BRIEF);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; funds: boolean } | null>(null);
  const [tier, setTier] = useState<TierInfo | null>(null);
  const [runs, setRuns] = useState<VentureSummary[] | null>(null);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    const c = new AbortController();
    client.ventureTier(c.signal).then(setTier, () => undefined);
    client.ventures(c.signal).then(setRuns, (e: unknown) => !c.signal.aborted && setLoadError(describeError(e)));
    client.recipes(c.signal).then(setRecipes, () => !c.signal.aborted && setRecipes([]));
    return () => c.abort();
  }, [client]);

  const info = modeInfo(mode)!;
  const problem = briefProblem(mode, form);
  const allowed = !tier || tierAllows(tier.tier, mode);
  const recipeUsd = recipe && recipe.mode === mode ? recipe.price_usd : 0;

  function pick(m: VentureMode) {
    setMode(m);
    setError(null);
    setTouched(false);
    if (recipe && recipe.mode !== m) setRecipe(null);
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!client || problem || !allowed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await client.startVenture(createBody(mode, form, recipe?.mode === mode ? recipe.id : null));
      router.push(`/dashboard/ventures/${encodeURIComponent(made.id)}`);
    } catch (err) {
      setError({ text: describeError(err), funds: isOutOfCredit(err) });
      setBusy(false);
    }
  }

  function runRecipe(r: Recipe) {
    setRecipe(r);
    setMode(r.mode);
    setError(null);
    document.getElementById('vx-brief')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  return (
    <div className="vx">
      <Hero tier={tier} />

      {ready && !client && (
        <div className="notice notice-action">
          <span>Connect a key to start a run. The crew is paid from the key’s balance, all-in, before it starts.</span>
          <Link className="btn btn-primary btn-small" href="/dashboard/key">
            Create a key
          </Link>
        </div>
      )}
      {sample && (
        <p className="vx-sample faint">
          <Info size={14} aria-hidden="true" /> Demo mode: runs use a sample key with demo credit on this device. Nothing leaves the browser.
        </p>
      )}

      <section className="vx-section" aria-labelledby="vx-modes-title">
        <header className="vx-section-head">
          <h2 id="vx-modes-title">Pick a mode</h2>
          <p className="muted">One price per run, everything included up to it. A model that refuses is rerouted and that attempt costs nothing.</p>
        </header>
        <div className="vx-modes" role="radiogroup" aria-label="Mode">
          {MODES.filter((m) => !m.soon).map((m) => (
            <ModeCard key={m.mode} info={m} selected={mode === m.mode} tier={tier} onPick={() => pick(m.mode)} />
          ))}
        </div>
        {MODES.filter((m) => m.soon).map((m) => (
          <div key={m.mode} className="vx-soon">
            <Sparkles size={16} aria-hidden="true" />
            <span>
              <strong>{m.title}</strong> · {m.pitch}
            </span>
            <span className="chip">Coming soon</span>
          </div>
        ))}
      </section>

      <form id="vx-brief" className="vx-brief" onSubmit={start} noValidate>
        <div className="vx-brief-main">
          <header className="vx-brief-head">
            <h2>
              {modeTitle(mode)}
              <span className="sr-only"> brief</span>
            </h2>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setForm({ ...EMPTY_BRIEF, ...SAMPLES[mode] })}>
              <FlaskConical size={15} aria-hidden="true" /> Use a sample
            </button>
          </header>
          {recipe && recipe.mode === mode && (
            <div className="vx-recipe-on">
              <BookOpen size={15} aria-hidden="true" />
              <span>
                Recipe: <strong>{recipe.title}</strong> · {recipe.steps.length} steps · {recipe.price_usd ? `+${usd(recipe.price_usd)} recipe, ${usd(recipe.price_usd * RECIPE_MAKER_SHARE, true)} to its maker` : 'free'}
              </span>
              <button type="button" className="btn btn-ghost btn-small" aria-label="Stop using this Recipe" onClick={() => setRecipe(null)}>
                <X size={15} />
              </button>
            </div>
          )}
          <BriefFields info={info} form={form} onChange={(f) => setForm({ ...form, ...f })} />
          {touched && problem && (
            <p className="vx-problem" role="alert">
              {problem}
            </p>
          )}
        </div>
        <aside className="vx-price" aria-label="Price">
          <span className="vx-price-kicker">Before anything is spent</span>
          <strong className="vx-price-big">{usd(info.usd + recipeUsd)}</strong>
          <span className="vx-price-line">{priceLine(mode, recipeUsd)}</span>
          <span className="vx-price-nymo">
            Paid in $NYMO: {usd(nymoPrice(info.usd), true)} ({NYMO_DISCOUNT_PCT}% less). Shown for information.
          </span>
          <span className={allowed ? 'vx-price-tier' : 'vx-price-tier vx-price-tier-no'}>
            {allowed ? <Crown size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
            {allowed ? `${tierLabel(tierFor(mode))} tier or above · you are ${tier ? tierLabel(tier.tier) : '…'}` : `Needs the ${tierLabel(tierFor(mode))} tier. Staking $NYMO raises it.`}
          </span>
          <button type="submit" className="btn btn-primary vx-go" disabled={!client || busy || !allowed}>
            {busy ? <Loader2 size={18} className="vx-spin" aria-hidden="true" /> : <Rocket size={18} aria-hidden="true" />}
            {busy ? 'Waking the crew…' : 'Start the crew'}
          </button>
          {error && (
            <div className="vx-error" role="alert">
              <span>{error.text}</span>
              {error.funds &&
                (addDemoCredit ? (
                  <button type="button" className="btn btn-small" onClick={() => void addDemoCredit(300).then(() => setError(null))}>
                    Add $300 demo credit
                  </button>
                ) : (
                  <Link className="btn btn-small" href="/dashboard/funds">
                    Add funds
                  </Link>
                ))}
            </div>
          )}
          <span className="faint vx-price-fine">For adults (18+) building their own business. The crew reads only public pages, logged out, and never copies their copy or code.</span>
        </aside>
      </form>

      <RunsList runs={runs} error={loadError} />
      <RecipeShelf recipes={recipes} tier={tier} onRun={runRecipe} />
      <TierLadder tier={tier} />
    </div>
  );
}

function Hero({ tier }: { tier: TierInfo | null }) {
  return (
    <section className="vx-hero" aria-labelledby="vx-hero-title">
      <div className="vx-hero-text">
        <span className="vx-kicker">Anonymo Ventures</span>
        <h2 id="vx-hero-title">Point the crew at any business. Get a better one, live.</h2>
        <p>Many models, one crew. Boss Mo plans, the crew builds side by side in sandboxes, Tester Mo keeps what passes, and every step lands on a receipt.</p>
        {tier && (
          <span className="vx-tierchip">
            <Crown size={14} aria-hidden="true" /> {tierLabel(tier.tier)} tier · {tier.rules.builders} Builder Mos · {tier.rules.families} families
          </span>
        )}
      </div>
      <ul className="vx-lineup" aria-label="The crew">
        {LINEUP.map((role, i) => (
          <li key={role} style={{ ['--i' as string]: i }}>
            <Mo role={role} size={76} state={i % 3 === 1 ? 'RUNNING' : 'idle'} />
            <strong>{CREW[role].name}</strong>
            <span className="vx-lineup-job">{CREW[role].job}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ModeCard({ info, selected, tier, onPick }: { info: ModeInfo; selected: boolean; tier: TierInfo | null; onPick: () => void }) {
  const Icon = MODE_ICONS[info.mode] ?? Rocket;
  const needs = tierFor(info.mode);
  const locked = !!tier && !tierAllows(tier.tier, info.mode);
  return (
    <button type="button" role="radio" aria-checked={selected} className="vx-mode" data-mode={info.mode} onClick={onPick}>
      <span className="vx-mode-top">
        <span className="vx-mode-icon">
          <Icon size={20} aria-hidden="true" />
        </span>
        <span className="vx-mode-price">
          {usd(info.usd)}
          <small> / run</small>
        </span>
      </span>
      <strong className="vx-mode-title">{info.title}</strong>
      <span className="vx-mode-pitch">{info.pitch}</span>
      <ul className="vx-mode-gets">
        {info.includes.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <span className="vx-mode-foot">
        <span className={locked ? 'chip chip-rose' : 'chip'}>
          {locked ? <Lock size={12} aria-hidden="true" /> : <Crown size={12} aria-hidden="true" />}
          {needs === 'solo' ? 'Any tier' : `${tierLabel(needs)} tier`}
        </span>
        {info.needs.includes('target_url') && <span className="chip chip-amber">Needs a rival’s URL</span>}
        {info.needs.includes('repo_url') && <span className="chip">Needs a repo URL</span>}
      </span>
    </button>
  );
}

function BriefFields({ info, form, onChange }: { info: ModeInfo; form: BriefForm; onChange: (f: Partial<BriefForm>) => void }) {
  const id = useId();
  const fields = [...info.needs, ...info.optional];
  const label = (f: string, text: string) => (
    <span>
      {text}
      {!info.needs.includes(f as never) && <span className="faint"> (optional)</span>}
    </span>
  );
  return (
    <div className="vx-fields">
      {fields.includes('target_url') && (
        <label className="field" htmlFor={`${id}-url`}>
          {label('target_url', 'Competitor’s public site')}
          <input id={`${id}-url`} className="input" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://rival.example" value={form.target_url} onChange={(e) => onChange({ target_url: e.target.value })} />
          <span className="faint vx-help">Scout Mo reads it logged out. Only a functional Spec crosses to the crew that builds.</span>
        </label>
      )}
      {fields.includes('rival') && (
        <label className="field" htmlFor={`${id}-rival`}>
          {label('rival', 'Rival’s name')}
          <input id={`${id}-rival`} className="input" autoComplete="off" maxLength={60} placeholder="As their customers know it" value={form.rival} onChange={(e) => onChange({ rival: e.target.value })} />
        </label>
      )}
      {fields.includes('repo_url') && (
        <label className="field" htmlFor={`${id}-repo`}>
          {label('repo_url', 'Open-source repo')}
          <input id={`${id}-repo`} className="input" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://git.example/owner/project" value={form.repo_url} onChange={(e) => onChange({ repo_url: e.target.value })} />
          <span className="faint vx-help">Licence Mo checks the licence first. If it can’t be forked, you get a clean-room plan instead.</span>
        </label>
      )}
      {fields.includes('brief') && (
        <label className="field" htmlFor={`${id}-brief`}>
          {label('brief', info.mode === 'IDEA_TO_LIVE' ? 'The idea, in a sentence or two' : 'What should yours do better?')}
          <textarea id={`${id}-brief`} className="textarea vx-textarea" maxLength={4000} rows={3} placeholder={info.mode === 'IDEA_TO_LIVE' ? 'Who it is for, and the one thing it does' : 'The gap you want to win on'} value={form.brief} onChange={(e) => onChange({ brief: e.target.value })} />
        </label>
      )}
      {fields.includes('brand') && (
        <label className="field" htmlFor={`${id}-brand`}>
          {label('brand', 'Your brand name')}
          <input id={`${id}-brand`} className="input" autoComplete="off" maxLength={60} placeholder="Leave empty and Strategist Mo names it" value={form.brand} onChange={(e) => onChange({ brand: e.target.value })} />
        </label>
      )}
    </div>
  );
}

function RunsList({ runs, error }: { runs: VentureSummary[] | null; error: string | null }) {
  const [now] = useState(() => Date.now());
  return (
    <section className="vx-section" aria-labelledby="vx-runs-title">
      <header className="vx-section-head">
        <h2 id="vx-runs-title">Your runs</h2>
        <p className="muted">Every run keeps its board, its results and its receipt.</p>
      </header>
      {error ? (
        <p className="notice notice-rose">{error}</p>
      ) : runs === null ? (
        <p className="faint">Loading runs…</p>
      ) : runs.length === 0 ? (
        <p className="faint">No runs yet. Pick a mode above.</p>
      ) : (
        <ul className="vx-runs">
          {runs.map((r) => (
            <li key={r.id}>
              <Link href={`/dashboard/ventures/${encodeURIComponent(r.id)}`} className="vx-run">
                <span className={`vx-status tone-${statusTone(r.status) === 'live' ? 'ok' : statusTone(r.status)}`} data-live={r.status === 'RUNNING' || undefined}>
                  <i aria-hidden="true" />
                  {statusLabel(r.status)}
                </span>
                <span className="vx-run-main">
                  <strong>{r.brand ?? modeTitle(r.mode)}</strong>
                  <span className="faint">
                    {modeTitle(r.mode)} · {relTime(r.created_at, now)}
                    {r.brief ? ` · ${r.brief}` : ''}
                  </span>
                </span>
                <span className="vx-run-cost">
                  {r.mode === 'RUN' ? <Repeat2 size={15} aria-hidden="true" /> : null}
                  {usd(r.cost_usd, true)} <span className="faint">of {usd(r.price_usd)}</span>
                </span>
                <ArrowRight size={16} aria-hidden="true" className="vx-run-go" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecipeShelf({ recipes, tier, onRun }: { recipes: Recipe[] | null; tier: TierInfo | null; onRun: (r: Recipe) => void }) {
  return (
    <section className="vx-section" aria-labelledby="vx-recipes-title">
      <header className="vx-section-head">
        <h2 id="vx-recipes-title">Recipes</h2>
        <p className="muted">Pipelines that worked, saved by the people who ran them: the steps and the fan-out, never their content. Run one on your own brief.</p>
      </header>
      {recipes === null ? (
        <p className="faint">Loading Recipes…</p>
      ) : recipes.length === 0 ? (
        <p className="faint">No Recipes yet. Save a finished run as one.</p>
      ) : (
        <ul className="vx-recipes">
          {recipes.map((r) => {
            const locked = !!tier && !tierAllows(tier.tier, r.mode);
            const roles = [...new Set(r.steps.map((s) => s.role))];
            return (
              <li key={r.id} className="vx-recipe">
                <header>
                  <span className="chip">{modeTitle(r.mode)}</span>
                  <span className="vx-recipe-price">{r.price_usd ? `+${usd(r.price_usd)}` : 'Free'}</span>
                </header>
                <strong>{r.title}</strong>
                <p className="muted">{r.summary}</p>
                <span className="vx-recipe-crew" aria-label={`${r.steps.length} steps`}>
                  {roles.slice(0, 7).map((role) => (
                    <Mo key={role} role={role} size={28} />
                  ))}
                  <span className="faint">
                    {r.steps.length} steps · run {r.runs.toLocaleString('en-US')} times
                  </span>
                </span>
                <button type="button" className="btn btn-outline btn-small" disabled={locked} onClick={() => onRun(r)}>
                  {locked ? <Lock size={14} aria-hidden="true" /> : <Rocket size={14} aria-hidden="true" />}
                  {locked ? `Needs ${tierLabel(tierFor(r.mode))}` : `Run this recipe · ${usd((modeInfo(r.mode)?.usd ?? 0) + r.price_usd)}`}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TierLadder({ tier }: { tier: TierInfo | null }) {
  return (
    <section className="vx-section" aria-labelledby="vx-tier-title">
      <header className="vx-section-head">
        <h2 id="vx-tier-title">Your tier</h2>
        <p className="muted">
          The tier sets how big the crew is. It follows the 7-day average of the $NYMO staked by the wallet your key signed in with: staking more raises it. There is
          nothing to stake from this page.
        </p>
      </header>
      <ol className="vx-ladder">
        {TIERS.map((t) => {
          const r = TIER_RULES[t];
          const here = tier?.tier === t;
          return (
            <li key={t} className="vx-rung" aria-current={here ? 'true' : undefined}>
              <header>
                <strong>{tierLabel(t)}</strong>
                {here && <span className="chip chip-signal">You</span>}
              </header>
              <span className="vx-rung-stake">{r.stakeNymo ? `${r.stakeNymo.toLocaleString('en-US')} $NYMO staked` : 'No stake'}</span>
              <ul>
                {tierPerks(r).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
      {tier && (
        <p className="faint vx-tier-src">
          {tier.source === 'chain' ? `Read from the CrewTiers contract${tier.twabNymo !== null ? `: ${tier.twabNymo.toLocaleString('en-US')} $NYMO 7-day average` : ''}.` : 'Every key gets this tier until the CrewTiers contract is live.'}
        </p>
      )}
    </section>
  );
}

export type { AnonymoClient };
