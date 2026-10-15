"use client";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  FileSearch,
  Link2,
  LoaderCircle,
  Plus,
  RotateCcw,
  Activity,
  BarChart3,
  CalendarDays,
  ChartNoAxesCombined,
  Coins,
  Database,
  Layers,
  LayoutDashboard,
  MessagesSquare,
  Network,
  ScanSearch,
  ShieldCheck,
  Trophy,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { parseFomoInput, fomoAnalysisPrompt, type FomoAnalysis } from "../../lib/second-look/fomo";
import {
  fomoProfileView,
  fomoCallsView,
  formatFomoMoney as money,
  formatFomoTime as time,
  finite,
  type FomoProfileView,
} from "../../lib/second-look/fomo-view";
import { fomoAnalysisResponse } from "../../lib/client/fomo-contracts";
import { ModelAnalysis } from "./chat/model-analysis";
import { ErrorNotice, useSecondLookApi, type PanelProps } from "./shared";
import { FomoResearchCard } from "./fomo-research-card";
import { FomoReviewDialog } from "./fomo-review-dialog";
import { FomoEntityImage } from "./fomo-entity-image";
import { FomoTopTen } from "./fomo-top10";
import "./fomo.css";

type View = "research" | "overview" | "positions" | "callouts" | "analyses" | "sources";
const views: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "research", label: "Research", icon: ShieldCheck },
  { id: "positions", label: "Positions", icon: Coins },
  { id: "callouts", label: "Callouts", icon: MessagesSquare },
  { id: "analyses", label: "Model analyses", icon: Layers },
  { id: "sources", label: "Sources", icon: Database },
];
export function FomoPanel(
  props: PanelProps & {
    initialAnalysis?: FomoAnalysis;
    example?: boolean;
    initialReviewOpen?: boolean;
    initialView?: View;
  },
) {
  const { accountId, onComposer, controlRef, onDraft, onSignIn, onToast, analysis: host } = props;
  const api = useSecondLookApi(accountId);
  const run = api.run;
  const [draft, setDraft] = useState(props.initialAnalysis?.input.url ?? "");
  const [context, setContext] = useState("");
  const [report, setReport] = useState<FomoAnalysis | null>(props.initialAnalysis ?? null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(props.initialView ?? "overview");
  const [sourceFocus, setSourceFocus] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(props.initialReviewOpen === true);
  const [openingProfile, setOpeningProfile] = useState(false);
  const displayedReportId = useRef(report?.id);
  const contextDetails = useRef<HTMLDetailsElement>(null);
  const contextField = useRef<HTMLTextAreaElement>(null);
  const deskRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Partial<Record<View, HTMLButtonElement>>>({});
  const openCollectedProfile = useCallback(async (handle: string) => {
    setOpeningProfile(true); setError('');
    try {
      const response = await fetch('/api/second-look/fomo/profiles/' + encodeURIComponent(handle), { credentials: 'omit' });
      const value: unknown = await response.json();
      if (!response.ok || !fomoAnalysisResponse(value)) throw Error('This profile could not be opened. Please try again.');
      setReport(value.analysis); setDraft(value.analysis.input.url); setView('overview'); onDraft('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to open research.'); }
    finally { setOpeningProfile(false); }
  }, [onDraft]);
  const inspect = useCallback(
    async (value: string) => {
      let parsed;
      try {
        parsed = parseFomoInput(value);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Check the link.");
        return;
      }
      if (parsed.kind === 'profile' && parsed.handle && !context.trim()) {
        await openCollectedProfile(parsed.handle);
        return;
      }
      if (!accountId) {
        onSignIn();
        return;
      }
      setError("");
      await run(async (request) => {
        const r = await request("second-look/fomo/analyze", {
          method: "POST",
          body: { input: parsed.url, context },
          validate: fomoAnalysisResponse,
        });
        setReport(r.analysis);
        setView("overview");
        setDraft(parsed.url);
        onDraft("");
      });
    },
    [accountId, run, context, onSignIn, onDraft, openCollectedProfile],
  );
  useImperativeHandle(controlRef, () => ({ submit: inspect }), [inspect]);
  useEffect(
    () =>
      onComposer({
        placeholder: "Paste a FOMO callout or profile link…",
        label: "Research FOMO",
        busy: api.busy || openingProfile,
      }),
    [onComposer, api.busy, openingProfile],
  );
  const profile = report ? fomoProfileView(report) : null;
  const publicCalls = report ? fomoCallsView(report) : null;
  const reviewTurn =
    report && host?.resultSubjectId === report.id
      ? host.turns?.findLast((turn) => turn.answers.length > 0)
      : undefined;
  const hasReview = Boolean(
    report && host?.resultSubjectId === report.id && (host.results || reviewTurn),
  );
  const lastReviewId = useRef(reviewTurn?.id);
  useEffect(() => {
    if (reviewTurn && reviewTurn.id !== lastReviewId.current) {
      lastReviewId.current = reviewTurn.id;
      setReviewOpen(true);
    }
  }, [reviewTurn]);
  useEffect(() => {
    if (displayedReportId.current !== report?.id) {
      displayedReportId.current = report?.id;
      setReviewOpen(false);
      rootRef.current?.scrollIntoView({ block: "start" });
    }
  }, [report?.id]);
  useEffect(() => {
    if (view !== "sources" || !sourceFocus) return;
    const target = document.getElementById("fomo-source-" + sourceFocus);
    if (target instanceof HTMLDetailsElement) {
      target.open = true;
      target.querySelector("summary")?.focus();
      target.scrollIntoView({block:"nearest"});
    }
  }, [view, sourceFocus]);
  const inspectSource = (id?: string) => { setSourceFocus(id ?? null); setView("sources"); };
  const retrieved = report?.sources.filter((s) => s.state !== "unavailable").length ?? 0;
  function addContext() {
    if (contextDetails.current) contextDetails.current.open = true;
    contextField.current?.focus();
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % views.length
        : event.key === "ArrowLeft"
          ? (index + views.length - 1) % views.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? views.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setView(views[next].id);
    tabRefs.current[views[next].id]?.focus();
  }
  return (
    <section
      ref={rootRef}
      className={`fomo-research${report ? " has-report" : " is-empty"}`}
      aria-label="FOMO research"
    >
      <div className="fomo-command-row">
        <div className="fomo-product-name">
          <ScanSearch size={18} className="fomo-brand-icon" aria-hidden="true" />
          FOMO <span>/ Research</span>
        </div>
        {!report && <span className="fomo-command-note">One link. Four independent analyses.</span>}
        {report && (
          <span className="fomo-command-note">
            {props.example ? "Saved research" : "Research collected"} · {time(report.createdAt)}
          </span>
        )}
      </div>
      {report && !props.initialAnalysis && <button className="fomo-topten-back" onClick={() => { setReport(null); setDraft(''); setError(''); setReviewOpen(false); }}>← Back to the top ten</button>}
      {!report && (
        <header className="fomo-entry-heading">
          <h1>
            Understand the call.
            <br />
            <span>And the person behind it.</span>
          </h1>
          <p>
            Start with the 30-day top ten. Open their research, inspect the calls, then compare four models.
          </p>
        </header>
      )}
      <form
        className="fomo-input"
        onSubmit={(e) => {
          e.preventDefault();
          void inspect(draft);
        }}
      >
        <label className="fomo-link">
          <Link2 size={18} />
          <input
            type="text"
            aria-label="FOMO callout or profile link"
            placeholder="Paste a FOMO profile or callout link"
            value={draft}
            maxLength={2048}
            onChange={(e) => {
              setDraft(e.target.value);
              setError("");
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button
          type="submit"
          aria-label="Collect FOMO evidence"
          disabled={!draft.trim() || api.busy || openingProfile}
        >
          {api.busy ? (
            <LoaderCircle className="fomo-spin" size={17} />
          ) : (
            <>
              <span>{report ? "Research" : "Inspect link"}</span>
              <ArrowRight size={17} />
            </>
          )}
        </button>
      </form>
      <details ref={contextDetails} className="fomo-context">
        <summary>
          <Plus size={13} /> Add callout text or context <ChevronDown size={12} />
        </summary>
        <label htmlFor="fomo-context-input">Context supplied by you</label>
        <textarea
          id="fomo-context-input"
          ref={contextField}
          value={context}
          maxLength={8000}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Paste the claim or add a question. Supplied text stays separate from retrieved evidence."
        />
      </details>
      <ErrorNotice message={error || api.error} />
      {api.busy && (
        <div className="fomo-loading" role="status">
          <LoaderCircle size={16} className="fomo-spin" /> Checking profile, callout and market
          sources…
        </div>
      )}
      {!report && <FomoTopTen onOpen={openCollectedProfile} busy={openingProfile || api.busy} />}
      {report && (
        <div className="fomo-report">
          <header className="fomo-dossier-heading">
            <div className="fomo-profile-identity">
              <FomoEntityImage
                src={profile?.avatarUrl}
                kind="profile"
                label={`${profile?.handle ?? report.input.handle ?? "Trader"} profile photo`}
              />
              <div className="fomo-profile-copy">
                <div className="fomo-profile-type">
                  {report.input.kind === "profile" ? "Trader profile" : "Callout research"}
                  {profile?.displayName && <span> / {profile.displayName}</span>}
                </div>
                <h1>
                  {report.input.handle
                    ? "@" + report.input.handle
                    : report.input.kind === "callout"
                      ? "Inside the callout."
                      : report.title}
                </h1>
                <div className="fomo-identity-meta">
                  {profile?.followers !== null && profile?.followers !== undefined && (
                    <span>
                      <Users size={14} aria-hidden="true" />
                      {profile.followers.toLocaleString()} followers
                    </span>
                  )}
                  <button onClick={() => setView("sources")}>
                    <Database size={14} aria-hidden="true" />
                    {retrieved}/{report.sources.length} sources
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
            <div className="fomo-heading-actions">
              <a href={report.input.url} target="_blank" rel="noreferrer">
                View on FOMO <ArrowUpRight size={14} />
              </a>
              <button
                type="button"
                disabled={api.busy}
                onClick={() => void inspect(report.input.url)}
              >
                <RotateCcw size={13} /> Refresh evidence
              </button>
            </div>
          </header>
          <nav className="fomo-tabs" role="tablist" aria-label="Research sections">
            {views.map((item, index) => (
              <button
                type="button"
                key={item.id}
                role="tab"
                id={`fomo-tab-${item.id}`}
                aria-selected={view === item.id}
                aria-controls="fomo-view"
                tabIndex={view === item.id ? 0 : -1}
                ref={(el) => {
                  if (el) tabRefs.current[item.id] = el;
                }}
                onClick={() => setView(item.id)}
                onKeyDown={(e) => moveTab(e, index)}
              >
                <item.icon size={17} strokeWidth={1.7} aria-hidden="true" />
                {item.label}
                {item.id === "positions" && !!profile?.holdings.length && (
                  <small>{profile.holdings.length}</small>
                )}
                {item.id === "sources" && <small>{report.sources.length}</small>}
              </button>
            ))}
          </nav>
          <button
            className="fomo-mobile-models"
            onClick={() => {
              deskRef.current?.scrollIntoView({
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                  ? "instant"
                  : "smooth",
              });
              deskRef.current?.focus({ preventScroll: true });
            }}
          >
            Choose four analysis models <ArrowRight size={15} />
          </button>
          <div className={`fomo-dossier-grid${view === "analyses" ? " is-reading" : ""}`}>
            <div
              id="fomo-view"
              role="tabpanel"
              aria-labelledby={`fomo-tab-${view}`}
              className="fomo-main-column"
              tabIndex={0}
            >
              {view === "overview" && (
                <>
                  <FomoResearchCard report={report} compact onSources={() => setView("research")} />
                  {report.callout && <Callout report={report} />}
                  {profile ? (
                    <>
                      <Performance profile={profile} />
                      <Positions profile={profile} compact onOpen={() => setView("positions")} />
                      <Accounting profile={profile} />
                    </>
                  ) : (
                    <div className="fomo-empty-section">
                      <FileSearch size={26} />
                      <h2>
                        {report.input.kind === "callout"
                          ? "Start with the claim."
                          : "No profile metrics in this snapshot."}
                      </h2>
                      <p>
                        {report.callout
                          ? "Read the available source material and compare how four models interpret it."
                          : "Performance metrics were not supplied. Callouts and other retrieved evidence remain available in their own tabs."}
                      </p>
                      <button onClick={() => setView("sources")}>
                        Inspect available evidence <ArrowRight size={15} />
                      </button>
                    </div>
                  )}
                  {hasReview && (
                    <button className="fomo-reading-invite" onClick={() => setReviewOpen(true)}>
                      <span>
                        <Layers size={20} aria-hidden="true" />
                        <strong>Open all four AI chats</strong>
                      </span>
                      <ArrowUpRight size={24} />
                    </button>
                  )}
                </>
              )}
              {view === "positions" &&
                (profile ? (
                  <>
                    <SectionHeading icon={Coins} title="Listed positions" />
                    <Positions profile={profile} />
                    <div className="fomo-method-note">
                      <CircleHelp size={17} />
                      <p>
                        These are listed positions, not a complete portfolio. Values use source
                        prices; a separate valuation time is not supplied. Position PnL covers the
                        time since each position opened.
                      </p>
                    </div>
                  </>
                ) : (
                  <EmptyEvidence
                    title="No listed positions available."
                    body="The retrieved sources do not provide a position list for this profile."
                  />
                ))}
              {view === "research" && <FomoResearchCard report={report} onSources={inspectSource} />}
              {view === "callouts" && <Callouts report={report} onAddContext={addContext} />}
              {view === "sources" && <Sources report={report} />}
              {view === "analyses" && (
                <>
                  <SectionHeading icon={Layers} title="Model analyses" />
                  <p className="fomo-section-intro">
                    Independent model responses to the same source material. Switch models or
                    compare them side by side.
                  </p>
                  {hasReview ? (
                    <>
                      <button className="fomo-review-open" onClick={() => setReviewOpen(true)}>
                        <Layers size={16} /> Open four evidence audits <ArrowUpRight size={15} />
                      </button>
                      <div className="fomo-answer-reader">{host?.results}</div>
                    </>
                  ) : (
                    <EmptyEvidence
                      title="Your analyses will appear here."
                      body="Choose four models in the research desk, then review the usage quote to begin. No analysis has been requested yet."
                    />
                  )}
                </>
              )}
            </div>
            <aside
              ref={deskRef}
              tabIndex={-1}
              className="fomo-research-desk"
              aria-label="Research desk"
            >
              {report.state === "unavailable" ? (
                <div className="fomo-unavailable" role="status">
                  <FileSearch size={22} />
                  <h2>More evidence needed.</h2>
                  <p>
                    Paste the exact callout text or try a profile listed on a public leaderboard. No
                    model request has been sent.
                  </p>
                  <button onClick={addContext}>
                    Add context <Plus size={15} />
                  </button>
                </div>
              ) : (
                <ModelAnalysis
                  key={report.id}
                  subject={{
                    id: report.id,
                    title: report.title,
                    evidence: fomoAnalysisPrompt(report),
                    example: props.example === true,
                  }}
                  accountId={accountId}
                  host={host}
                  onOpenReview={hasReview ? () => setReviewOpen(true) : undefined}
                  onSignIn={onSignIn}
                  onToast={onToast}
                />
              )}
              <section className="fomo-coverage-summary">
                <h3>
                  <FileSearch size={17} aria-hidden="true" />
                  Evidence at a glance
                </h3>
                <dl>
                  <div>
                    <dt>
                      <UserRound size={15} aria-hidden="true" />
                      Profile snapshot
                    </dt>
                    <dd>
                      {profile || report.sources.some((s) => s.id === "profile" && s.data)
                        ? "Retrieved"
                        : "Not retrieved"}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <Coins size={15} aria-hidden="true" />
                      Listed positions
                    </dt>
                    <dd>{profile?.holdings.length ? "Retrieved" : "Not supplied"}</dd>
                  </div>
                  <div>
                    <dt>
                      <Wallet size={15} aria-hidden="true" />
                      Wallet attribution
                    </dt>
                    <dd>{profile?.walletsKnown ? "Source linked" : "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>
                      <MessagesSquare size={15} aria-hidden="true" />
                      Callout history
                    </dt>
                    <dd>
                      {publicCalls?.items.length
                        ? `${publicCalls.items.length} dated calls`
                        : publicCalls?.retrieved ? "No matching calls" : "Not available"}
                    </dd>
                  </div>
                </dl>
                <button onClick={() => setView("sources")}>
                  Inspect all {report.sources.length} sources <ArrowUpRight size={14} />
                </button>
                <p>Public-feed coverage. Missing data is shown, never filled in.</p>
              </section>
              {profile && (
                <section className="fomo-lifetime">
                  <h3>
                    <Activity size={17} aria-hidden="true" />
                    {profile.sampled ? "Stored profile totals" : "Lifetime profile totals"}
                  </h3>
                  <div>
                    <span>Reported PnL</span>
                    <strong>{money(profile.lifetimePnl, true)}</strong>
                  </div>
                  <div>
                    <span>Profile trades</span>
                    <strong>{profile.lifetimeTrades?.toLocaleString() ?? "Not available"}</strong>
                  </div>
                  <p>
                    {time(profile.totalsObservedAt)}
                    <br />
                    Separate from the leaderboard and 30-day figures.
                  </p>
                </section>
              )}
            </aside>
          </div>
        </div>
      )}
      {report && (
        <FomoReviewDialog
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          title={report.input.handle ? "@" + report.input.handle : report.title}
          subjectKind={report.input.kind}
          avatarUrl={profile?.avatarUrl}
          turn={reviewTurn}
          models={host?.models ?? []}
          onToast={onToast}
        />
      )}
    </section>
  );
}
function SectionHeading({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="fomo-section-heading">
      <h2>
        <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
        {title}
      </h2>
      {children}
    </header>
  );
}
function EmptyEvidence({ title, body }: { title: string; body: string }) {
  return (
    <div className="fomo-empty-section">
      <FileSearch size={25} />
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}
function Performance({ profile: p }: { profile: FomoProfileView }) {
  return (
    <section className="fomo-performance" aria-label="Profile performance">
      <div className="fomo-performance-top">
        <h2>
          <ChartNoAxesCombined size={19} aria-hidden="true" />
          Performance
        </h2>
        <span className="fomo-period">
          <CalendarDays size={13} aria-hidden="true" />
          {p.window}
        </span>
      </div>
      <div className="fomo-headline-stats">
        <div>
          <p>{p.sourceLabel} PnL</p>
          <strong className="fomo-headline-number">{money(p.reportedPnl, false, true)}</strong>
          <span>{p.basis}</span>
        </div>
        <div className="fomo-rank">
          <p>
            <Trophy size={14} aria-hidden="true" />
            {p.sampled ? "Sample position" : "Leaderboard rank"}
          </p>
          <strong>{p.rank === null ? "—" : "#" + p.rank}</strong>
          <span>{p.sampled ? "Not FOMO rank" : "Public top-10 board"}</span>
        </div>
      </div>
      <p className="fomo-timestamp">
        {p.stale && <strong>Source marked stale · </strong>}
        {time(p.source.observedAt)} <span>·</span> Source-reported, not independently audited
      </p>
    </section>
  );
}
function Accounting({ profile: p }: { profile: FomoProfileView }) {
  const max = Math.max(Math.abs(p.realized30d ?? 0), Math.abs(p.unrealized30d ?? 0), 1);
  return (
    <>
      {(p.realized30d !== null || p.unrealized30d !== null) && (
        <section className="fomo-accounting">
          <div className="fomo-accounting-heading">
            <div>
              <h2>
                <BarChart3 size={20} aria-hidden="true" />
                30-day breakdown
              </h2>
            </div>
            <span className="fomo-period">
              <CalendarDays size={13} aria-hidden="true" />
              30d
            </span>
          </div>
          {p.lowPriceCoverage && (
            <p className="fomo-pricing-note">
              Incomplete pricing coverage: some positions could not be valued.
            </p>
          )}
          <div className="fomo-accounting-bars">
            {[
              { label: "Realized PnL", value: p.realized30d },
              { label: "Unrealized PnL", value: p.unrealized30d },
            ].map((row) => (
              <div className="fomo-accounting-row" key={row.label}>
                <div>
                  <span>{row.label}</span>
                  <strong className={row.value !== null && row.value < 0 ? "is-negative" : ""}>
                    {money(row.value, false, true)}
                  </strong>
                </div>
                <div className="fomo-bar-track" aria-hidden="true">
                  <div
                    className={row.value !== null && row.value < 0 ? "is-negative" : ""}
                    style={{
                      width: `${row.value === null ? 0 : (Math.abs(row.value) / max) * 100}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <dl className="fomo-accounting-totals">
            <div>
              <dt>Computed net PnL</dt>
              <dd>{money(p.net30d, true, true)}</dd>
            </div>
            <div>
              <dt>Traded volume</dt>
              <dd>{money(p.volume30d, true)}</dd>
            </div>
            <div>
              <dt>Trades</dt>
              <dd>{p.trades30d?.toLocaleString() ?? "Not available"}</dd>
            </div>
          </dl>
          <p className="fomo-scope-note">
            Provider calculations over 30 days. Not a breakdown of the {p.window} headline. A
            separate observation time is not supplied.
          </p>
        </section>
      )}
    </>
  );
}
function Positions({
  profile: p,
  compact,
  onOpen,
}: {
  profile: FomoProfileView;
  compact?: boolean;
  onOpen?: () => void;
}) {
  return (
    <section className="fomo-positions" aria-label="Listed positions">
      {compact && (
        <SectionHeading icon={Coins} title="Listed positions">
          <button onClick={onOpen}>
            View details <ArrowUpRight size={15} />
          </button>
        </SectionHeading>
      )}
      {!p.holdings.length ? (
        <p className="fomo-section-intro">No position list was supplied.</p>
      ) : (
        <div
          className="fomo-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Listed position values"
        >
          <table>
            <thead>
              <tr>
                <th>Asset / network</th>
                <th>Position value</th>
                <th>PnL since opened</th>
              </tr>
            </thead>
            <tbody>
              {p.holdings.map((h, i) => (
                <tr key={String(h.tokenAddress ?? i)}>
                  <td>
                    <div className="fomo-asset">
                      <FomoEntityImage
                        src={h.imageUrl}
                        label={`${String(h.symbol ?? "Asset")} token artwork`}
                      />
                      <span>
                        <b>{String(h.symbol ?? "Unknown asset")}</b>
                        <small>
                          {h.network === "solana" ? (
                            <img
                              className="fomo-network-icon"
                              src="/brand/providers/solana.svg"
                              alt=""
                              aria-hidden="true"
                            />
                          ) : (
                            <Network size={11} aria-hidden="true" />
                          )}
                          {String(h.network ?? "Network unknown")}
                          {!compact && typeof h.name === "string" ? " · " + h.name : ""}
                        </small>
                        {!compact && typeof h.tokenAddress === "string" && (
                          <code>{h.tokenAddress}</code>
                        )}
                      </span>
                    </div>
                  </td>
                  <td>{money(h.valueUsd, true)}</td>
                  <td
                    className={(finite(h.lifetimePnlUsd ?? h.pnlUsd) ?? 0) < 0 ? "is-negative" : ""}
                  >
                    {money(h.lifetimePnlUsd ?? h.pnlUsd, true, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {compact && (
        <p className="fomo-scope-note">
          Listed positions only. Not total portfolio value or current execution prices.
        </p>
      )}
    </section>
  );
}
function Callout({ report }: { report: FomoAnalysis }) {
  if (!report.callout) return null;
  return (
    <section className="fomo-callout">
      <div className="fomo-kicker">
        {report.callout.verified ? "SOURCE-MATCHED CALLOUT" : "CONTEXT SUPPLIED BY YOU"}
      </div>
      <blockquote>{report.callout.text}</blockquote>
      <p>
        {report.callout.author ? "@" + report.callout.author : "Supplied context"} ·{" "}
        {time(report.callout.createdAt)}
      </p>
    </section>
  );
}
function Callouts({ report, onAddContext }: { report: FomoAnalysis; onAddContext: () => void }) {
  const { retrieved: feedRetrieved, items, scope } = fomoCallsView(report);
  return (
    <section>
      <SectionHeading icon={MessagesSquare} title="Callouts & context" />
      {report.callout && <Callout report={report} />}{" "}
      {items.length > 0 ? (
        <div className="fomo-call-list">
          <p className="fomo-section-intro">{scope}</p>
          {items.map((item, index) => (
            <article key={index}>
              <span className="fomo-kicker">PUBLIC CALL {index + 1}</span>
              <p>
                {String(item.text ?? item.thesis ?? item.content ?? "Callout text not supplied.")}
              </p>
              {item.textTruncated === true && <small>Text shortened by the public source.</small>}
              <small>
                {typeof (item.createdAt ?? item.fomoCreatedAt) === "string"
                  ? time(String(item.createdAt ?? item.fomoCreatedAt))
                  : "Publication time not supplied"}
              </small>
              <details>
                <summary>Inspect source fields</summary>
                <pre>{JSON.stringify(item, null, 2)}</pre>
              </details>
            </article>
          ))}
        </div>
      ) : (
        <div className="fomo-empty-section">
          <FileSearch size={28} />
          <h2>
            {feedRetrieved
              ? report.callout
                ? "No additional matching calls in this feed."
                : "No matching call in this feed."
              : "Recent callout feed unavailable."}
          </h2>
          <p>{scope}</p>
          <button onClick={onAddContext}>
            Add a specific callout <Plus size={15} />
          </button>
        </div>
      )}
      {items.length === 0 && <p className="fomo-scope-note">
        An empty feed does not mean this trader has never made a call.
      </p>}
    </section>
  );
}
function Sources({ report }: { report: FomoAnalysis }) {
  return (
    <section>
      <SectionHeading icon={Database} title="Source records" />
      <p className="fomo-section-intro">
        Every model receives the same records and coverage limits.
      </p>
      <div className="fomo-evidence">
        {report.sources.map((s) => (
          <details key={s.id} id={"fomo-source-" + s.id}>
            <summary>
              <span className="fomo-source-index" aria-hidden="true">
                {s.id.includes("profile") ? (
                  <UserRound size={18} />
                ) : s.id.includes("calls") || s.id === "callout" ? (
                  <MessagesSquare size={18} />
                ) : (
                  <Database size={18} />
                )}
              </span>
              <span>
                {s.label}
                <small>{s.state === "unavailable" ? "Not retrieved" : time(s.observedAt)}</small>
              </span>
              <span className="fomo-source-state">
                {s.state === "unavailable" ? <FileSearch size={15} /> : <Check size={15} />}{" "}
                {s.state === "unavailable"
                  ? "Unavailable"
                  : s.state === "partial"
                    ? "Partial"
                    : "Retrieved"}
              </span>
              <ChevronDown size={14} />
            </summary>
            <div className="fomo-source-detail">
              <p>{s.note}</p>
              <code>{s.id}</code>
              <a href={s.url} target="_blank" rel="noreferrer">
                Open source <ArrowUpRight size={14} />
              </a>
              {s.data && (
                <details className="fomo-raw-data">
                  <summary>Inspect raw source fields</summary>
                  <pre>{JSON.stringify(s.data, null, 2)}</pre>
                </details>
              )}
            </div>
          </details>
        ))}
      </div>
      <section className="fomo-method-note">
        <CircleHelp size={18} />
        <div>
          <h3>How to read this research</h3>
          {report.limitations.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </div>
      </section>
    </section>
  );
}
