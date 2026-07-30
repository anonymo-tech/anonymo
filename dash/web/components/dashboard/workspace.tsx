"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import Link from "@/components/site-link";
import Image from "next/image";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns3,
  Eye,
  EyeOff,
  FileText,
  Fingerprint,
  Globe2,
  KeyRound,
  LockKeyhole,
  Menu,
  MessageSquare,
  Plus,
  ReceiptText,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  UsersRound,
  Wallet,
  X,
} from "lucide-react";
import {
  allowedRoute,
  briefMarkdown,
  downloadFile,
  INITIAL_BRIEFS,
  INITIAL_MEMBERS,
  isBrief,
  isMember,
  MODELS,
  SAMPLE_ANSWERS,
  scanPrompt,
  SCENARIOS,
  VIEW_NAMES,
  type Brief,
  type DemoModel,
  type GuardResult,
  type Member,
  type Privacy,
  type View,
} from "./data";
import { Corners, Flourish, Seal } from "./ornament";
import { HorseMark } from "@/components/conclave/horse-mark";
import { Wordmark } from "@/components/conclave/wordmark";

const NAV: { view: View; icon: typeof MessageSquare; group?: string }[] = [
  { view: "room", icon: MessageSquare, group: "WORKSPACE" },
  { view: "compare", icon: Columns3 },
  { view: "briefs", icon: BookOpen },
  { view: "crosscheck", icon: ShieldCheck },
  { view: "sanctum", icon: Fingerprint },
  { view: "routes", icon: Shield },
  { view: "explainer", icon: Globe2 },
  { view: "chapters", icon: UsersRound, group: "YOUR CHAPTER" },
  { view: "receipts", icon: ReceiptText },
  { view: "balance", icon: Wallet },
  { view: "developers", icon: Code2 },
  { view: "settings", icon: Settings2 },
];
const STORAGE_KEY = "conclave-demo-workspace-v1";
type ModalName = "models" | "topup" | "identity" | "reset" | null;

function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`dw-badge ${tone}`}>{children}</span>;
}
function SectionTitle({
  number,
  title,
  copy,
  action,
}: {
  number: string;
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <div className="dw-section-title">
      <div>
        <span className="dw-eyebrow">{number} / CONCLAVE WORKSPACE</span>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {action}
    </div>
  );
}
function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="dw-empty">
      <Seal />
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => {
      node?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dw-dialog"
      aria-label={title}
      onCancel={onClose}
    >
      <div className="dw-dialog-body">
        <div className="dw-dialog-head">
          <div>
            <span className="dw-eyebrow">CONCLAVE / LOCAL DEMO</span>
            <h2>{title}</h2>
          </div>
          <button
            className="dw-icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export default function Workspace() {
  const [view, setView] = useState<View>("room");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [modal, setModal] = useState<ModalName>(null);
  const [route, setRoute] = useState<DemoModel | null>(null);
  const [selected, setSelected] = useState(["claude", "gpt", "qwen"]);
  const [privacy, setPrivacy] = useState<Privacy>("all");
  const [briefs, setBriefs] = useState<Brief[]>(INITIAL_BRIEFS);
  const [members, setMembers] = useState<Member[]>(INITIAL_MEMBERS);
  const [workspaceName, setWorkspaceName] = useState("The first chapter");
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState("");
  const [conversationKey, setConversationKey] = useState(0);
  const [modelSearch, setModelSearch] = useState("");
  const [quietMotion, setQuietMotion] = useState(false);

  useEffect(() => {
    function syncView() {
      const raw =
        window.location.hash.slice(1) ||
        new URLSearchParams(window.location.search).get("view") ||
        "room";
      setView(Object.hasOwn(VIEW_NAMES, raw) ? (raw as View) : "room");
    }
    window.addEventListener("hashchange", syncView);
    const hydrationFrame = window.requestAnimationFrame(() => {
      syncView();
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        if (saved) {
          if (typeof saved.workspaceName === "string")
            setWorkspaceName(saved.workspaceName.slice(0, 50));
          if (["all", "private", "sealed"].includes(saved.privacy)) {
            setPrivacy(saved.privacy);
            setSelected(
              MODELS.filter((m) => allowedRoute(m, saved.privacy))
                .slice(0, 3)
                .map((m) => m.id),
            );
          }
          if (Array.isArray(saved.briefs))
            setBriefs(saved.briefs.filter(isBrief).slice(0, 100));
          if (Array.isArray(saved.members))
            setMembers(saved.members.filter(isMember).slice(0, 50));
          setQuietMotion(saved.quietMotion === true);
        }
      } catch {
        /* Browser storage is optional. The default demo remains usable. */
      }
      setReady(true);
    });
    return () => {
      window.cancelAnimationFrame(hydrationFrame);
      window.removeEventListener("hashchange", syncView);
    };
  }, []);

  useEffect(() => {
    if (ready) {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            workspaceName,
            privacy,
            briefs,
            members,
            quietMotion,
          }),
        );
      } catch {
        /* Private browsing may disable local storage. */
      }
    }
  }, [ready, workspaceName, privacy, briefs, members, quietMotion]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function navigate(next: View) {
    if (next === "sanctum")
      setSelected((current) => {
        const eligible = current.filter(
          (id) => MODELS.find((m) => m.id === id)?.kind === "Sealed",
        );
        return eligible.length ? eligible : ["qwen"];
      });
    setView(next);
    window.location.hash = next;
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function changePrivacy(next: Privacy) {
    setPrivacy(next);
    setSelected((current) =>
      current.filter((id) =>
        allowedRoute(
          MODELS.find((m) => m.id === id)!,
          next,
        ),
      ),
    );
    setToast(
      next === "all"
        ? "All sample routes are available."
        : "Strict policy applied. Ineligible routes removed; no fallback.",
    );
  }
  function toggleModel(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((m) => m !== id);
      if (current.length >= 4) {
        setToast("Choose up to four models for a comparison.");
        return current;
      }
      return [...current, id];
    });
  }
  function saveBrief(title: string, modelIds: string[]) {
    const brief: Brief = {
      id: `demo-${Date.now()}`,
      title,
      models: modelIds,
      date: new Date().toISOString().slice(0, 10),
      decision: "",
      sample: true,
    };
    setBriefs((current) => [brief, ...current]);
    navigate("briefs");
    setToast("Sample Brief saved in this browser.");
  }
  const selectedModels = selected
    .map((id) => MODELS.find((m) => m.id === id)!)
    .filter(Boolean);

  return (
    <div className={`dw ${quietMotion ? "dw-quiet" : ""}`}>
      <Link className="dw-skip" href="#workspace-content">
        Skip to workspace
      </Link>
      {mobileOpen && (
        <button
          className="dw-sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`dw-sidebar ${mobileOpen ? "is-open" : ""}`}
        aria-label="Workspace navigation"
      >
        <Link className="dw-brand" href="/" aria-label="Conclave home">
          <HorseMark className="dw-brand-horse" />
          <Wordmark />
          <sup>®</sup>
        </Link>
        <button
          className="dw-workspace-switch"
          onClick={() => navigate("chapters")}
        >
          <span className="dw-avatar">C</span>
          <span>
            <b>{workspaceName}</b>
            <small>Personal workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <button
          className="dw-new-chat"
          onClick={() => {
            setConversationKey((k) => k + 1);
            navigate("room");
          }}
        >
          <Plus size={16} /> New conversation <span>↗</span>
        </button>
        <nav>
          {NAV.map(({ view: item, icon: Icon, group }) => (
            <div key={item}>
              {group && <span className="dw-nav-label">{group}</span>}
              <Link
                href={`#${item}`}
                aria-current={view === item ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(item);
                }}
                className={`dw-nav-item ${view === item ? "is-active" : ""}`}
              >
                <Icon size={17} strokeWidth={1.6} />
                <span>{VIEW_NAMES[item]}</span>
                {item === "sanctum" && <span className="dw-nav-dot" />}
                {item === "briefs" && <small>{briefs.length}</small>}
              </Link>
            </div>
          ))}
        </nav>
        <div className="dw-sidebar-bottom">
          <div className="dw-sidebar-note">
            <ShieldCheck size={17} />
            <div>
              <b>Your browser. Your room.</b>
              <span>Local demo · no AI calls</span>
            </div>
          </div>
          <Link href="/docs" className="dw-help-link">
            <BookOpen size={15} /> Field guide <ArrowUpRight size={14} />
          </Link>
          <button className="dw-profile" onClick={() => setModal("identity")}>
            <span className="dw-avatar dw-avatar-dark">Y</span>
            <span>
              <b>Explorer</b>
              <small>Demo workspace</small>
            </span>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <div className="dw-shell">
        <header className="dw-topbar">
          <div className="dw-breadcrumb">
            <button
              className="dw-icon-button dw-mobile-menu"
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              <Menu size={21} />
            </button>
            <span className="dw-breadcrumb-home">Workspace</span>
            <ChevronRight size={13} />
            <strong>{VIEW_NAMES[view]}</strong>
          </div>
          <div className="dw-top-actions">
            <Badge tone="demo">
              <span /> SAMPLE DATA
            </Badge>
            <button
              className="dw-top-balance"
              onClick={() => navigate("balance")}
            >
              <Wallet size={14} />
              <b>24.68</b>
              <span>USDC</span>
            </button>
            <button
              className="dw-icon-button dw-top-avatar"
              aria-label="Account and sign-in status"
              onClick={() => setModal("identity")}
            >
              Y
            </button>
          </div>
        </header>
        <main className="dw-content" id="workspace-content" tabIndex={-1}>
          {(view === "room" || view === "compare" || view === "sanctum") && (
            <Room
              key={`${view}-${conversationKey}`}
              view={view}
              models={
                view === "sanctum"
                  ? selectedModels.filter((m) => m.kind === "Sealed" && m.open)
                  : selectedModels.filter((m) => allowedRoute(m, privacy))
              }
              privacy={view === "sanctum" ? "sealed" : privacy}
              onPrivacy={changePrivacy}
              onModels={() => {
                if (view === "sanctum")
                  setSelected((current) =>
                    current.filter(
                      (id) =>
                        MODELS.find((m) => m.id === id)?.kind === "Sealed",
                    ),
                  );
                setModelSearch("");
                setModal("models");
              }}
              onRoute={setRoute}
              onNavigate={navigate}
              onSave={saveBrief}
              onToast={setToast}
            />
          )}
          {view === "routes" && (
            <RouteLibrary
              privacy={privacy}
              onPrivacy={changePrivacy}
              onRoute={setRoute}
              onModels={() => setModal("models")}
            />
          )}
          {view === "briefs" && (
            <Briefs
              briefs={briefs}
              setBriefs={setBriefs}
              onNavigate={navigate}
              onToast={setToast}
            />
          )}
          {view === "crosscheck" && <CrossCheck onToast={setToast} />}
          {view === "explainer" && <Explainer />}
          {view === "chapters" && (
            <Chapters
              members={members}
              setMembers={setMembers}
              name={workspaceName}
              onToast={setToast}
            />
          )}
          {view === "receipts" && <Receipts onToast={setToast} />}
          {view === "balance" && (
            <Balance onTopup={() => setModal("topup")} onNavigate={navigate} />
          )}
          {view === "developers" && <Developers onToast={setToast} />}
          {view === "settings" && (
            <Settings
              name={workspaceName}
              onName={setWorkspaceName}
              privacy={privacy}
              onPrivacy={changePrivacy}
              quietMotion={quietMotion}
              setQuietMotion={setQuietMotion}
              onReset={() => setModal("reset")}
              onIdentity={() => setModal("identity")}
              onToast={setToast}
            />
          )}
          <footer className="dw-footer">
            <span>
              CONCLAVE <span>✦</span> MANY MINDS. YOUR JUDGMENT.
            </span>
            <Link href="/docs">
              Read the field guide <ArrowUpRight size={12} />
            </Link>
          </footer>
        </main>
      </div>
      {toast && (
        <output className="dw-toast">
          <Check size={17} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </output>
      )}
      {modal === "models" && (
        <Modal title="Choose your minds." onClose={() => setModal(null)}>
          <p className="dw-muted">
            Choose up to four sample routes. Actual availability and provider
            terms must be verified before launch.
          </p>
          <label className="dw-search">
            <Search size={18} />
            <input
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              placeholder="Search models or specialties…"
              aria-label="Search models"
            />
          </label>
          <div className="dw-model-filter">
            <span className="dw-eyebrow">MINIMUM ROUTE</span>
            <select
              aria-label="Minimum route for model selection"
              value={view === "sanctum" ? "sealed" : privacy}
              disabled={view === "sanctum"}
              onChange={(e) => changePrivacy(e.target.value as Privacy)}
            >
              <option value="all">All routes</option>
              <option value="private">Zero retention or sealed</option>
              <option value="sealed">Sealed open models only</option>
            </select>
          </div>
          <div className="dw-model-list">
            {MODELS.filter((m) =>
              `${m.name} ${m.family} ${m.specialty}`
                .toLowerCase()
                .includes(modelSearch.toLowerCase()),
            ).map((model) => {
              const allowed = allowedRoute(
                model,
                view === "sanctum" ? "sealed" : privacy,
              );
              return (
                <button
                  key={model.id}
                  className={`dw-model-choice ${selected.includes(model.id) ? "is-selected" : ""}`}
                  disabled={!allowed && !selected.includes(model.id)}
                  aria-pressed={selected.includes(model.id)}
                  onClick={() => toggleModel(model.id)}
                >
                  <span
                    className="dw-model-monogram"
                    style={{ "--model-color": model.color } as CSSProperties}
                  >
                    {model.monogram}
                  </span>
                  <span>
                    <b>
                      {model.name} <small>{model.family}</small>
                    </b>
                    <span>
                      {allowed
                        ? model.specialty
                        : "Blocked by your strict route policy"}
                    </span>
                  </span>
                  <Badge tone={model.kind.toLowerCase()}>{model.kind}</Badge>
                  <span className="dw-checkbox">
                    {selected.includes(model.id) && <Check size={14} />}
                  </span>
                </button>
              );
            })}
            {!MODELS.some((m) =>
              `${m.name} ${m.family} ${m.specialty}`
                .toLowerCase()
                .includes(modelSearch.toLowerCase()),
            ) && (
              <p className="dw-inline-note">
                No sample models match “{modelSearch}”. Try a model family.
              </p>
            )}
          </div>
          <div className="dw-dialog-actions">
            <span className="dw-muted">{selected.length} / 4 selected</span>
            <button
              className="dw-button dw-button-red"
              onClick={() => setModal(null)}
            >
              Use selected models <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
      {route && <RouteModal model={route} onClose={() => setRoute(null)} />}
      {modal === "topup" && <Topup onClose={() => setModal(null)} />}
      {modal === "identity" && (
        <Modal
          title="Your identity. Your choice."
          onClose={() => setModal(null)}
        >
          <div className="dw-identity-mark">
            <Fingerprint size={44} strokeWidth={1} />
          </div>
          <p>
            Wallet and passkey authentication belong to the live Conclave
            service. This preview runs locally without an account.
          </p>
          <div className="dw-spec-row">
            <Wallet size={19} />
            <span>
              <b>Solana wallet</b>
              <small>Domain-bound sign-in · live integration required</small>
            </span>
            <Badge>Planned</Badge>
          </div>
          <div className="dw-spec-row">
            <Fingerprint size={19} />
            <span>
              <b>Passkey</b>
              <small>Device-based sign-in · live integration required</small>
            </span>
            <Badge>Planned</Badge>
          </div>
          <p className="dw-inline-note">
            No wallet is connected. No signature is requested. Demo preferences
            are stored only in this browser.
          </p>
          <button
            className="dw-button dw-button-dark dw-button-full"
            onClick={() => setModal(null)}
          >
            Continue exploring <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {modal === "reset" && (
        <Modal title="A clean slate." onClose={() => setModal(null)}>
          <p>
            This removes this browser’s demo Briefs, team changes, and settings.
            It does not affect a live account.
          </p>
          <div className="dw-dialog-actions">
            <button className="dw-button" onClick={() => setModal(null)}>
              Keep my demo
            </button>
            <button
              className="dw-button dw-button-red"
              onClick={() => {
                setBriefs(INITIAL_BRIEFS);
                setMembers(INITIAL_MEMBERS);
                setWorkspaceName("The first chapter");
                setPrivacy("all");
                setSelected(["claude", "gpt", "qwen"]);
                setQuietMotion(false);
                setConversationKey((k) => k + 1);
                setModal(null);
                setToast("Demo restored to its initial state.");
              }}
            >
              Reset local demo
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

type RoomProps = {
  view: "room" | "compare" | "sanctum";
  models: DemoModel[];
  privacy: Privacy;
  onPrivacy: (p: Privacy) => void;
  onModels: () => void;
  onRoute: (m: DemoModel) => void;
  onNavigate: (v: View) => void;
  onSave: (title: string, ids: string[]) => void;
  onToast: (text: string) => void;
};

function Room({
  view,
  models,
  privacy,
  onPrivacy,
  onModels,
  onRoute,
  onNavigate,
  onSave,
  onToast,
}: RoomProps) {
  const [prompt, setPrompt] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [guard, setGuard] = useState<GuardResult | null>(null);
  const [blind, setBlind] = useState(false);
  const [vote, setVote] = useState<string | null>(null);
  const [responseModels, setResponseModels] = useState<DemoModel[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const isCompare = view === "compare";
  const isSanctum = view === "sanctum";

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim()) {
      composerRef.current?.focus();
      return;
    }
    const blocked = scanPrompt(prompt);
    setGuard(blocked);
    if (blocked) return;
    if (!models.length) {
      onToast("No eligible route selected. Choose a model to continue.");
      return;
    }
    if (isCompare && models.length < 2) {
      onToast("Side by Side needs at least two eligible models.");
      return;
    }
    setSubmitted(prompt.trim());
    setResponseModels(
      isCompare ? [...models].sort(() => Math.random() - 0.5) : [models[0]],
    );
    setVote(null);
    setPrompt("");
  }
  function samplePrompt(text: string) {
    setPrompt(text);
    setGuard(null);
    composerRef.current?.focus();
  }

  return (
    <>
      {view === "room" && !submitted ? (
        <>
          <div className="dw-welcome-line">
            <span className="dw-eyebrow">
              YOUR PRIVATE ROOM, DEFINED BY ITS ROUTES.
            </span>
            <span className="dw-eyebrow">VOL. 001 / EXPLORER</span>
          </div>
          <section className="dw-welcome">
            <Corners />
            <div className="dw-welcome-copy">
              <span className="dw-eyebrow">MANY MODELS. ONE WORKSPACE.</span>
              <h1>
                Make room
                <br />
                for <em>another mind.</em>
              </h1>
              <p>
                Compare perspectives. Keep your judgment.
                <br />
                Nothing leaves without a label.
              </p>
              <span className="dw-welcome-foot">
                A CONCLAVE OF POSSIBILITIES <span>✦</span>
              </span>
            </div>
            <Image
              unoptimized
              width={1024}
              height={1024}
              src="/brand/conclave-horse-logo-square-v1.png"
              alt="Engraved black horse leaping across a scarlet field"
              className="dw-welcome-horse"
            />
            <div className="dw-welcome-orbit">
              <Seal />
            </div>
          </section>
          <div className="dw-room-heading">
            <div>
              <h2>Where shall we begin?</h2>
              <p>One question. A few more ways to see it.</p>
            </div>
            <span className="dw-eyebrow">THE ROOM IS YOURS ↘</span>
          </div>
          <div className="dw-launch-grid">
            <button
              className="dw-launch-card"
              onClick={() => onNavigate("compare")}
            >
              <span className="dw-launch-num">01 / PERSPECTIVE</span>
              <Columns3 size={28} strokeWidth={1} />
              <h3>Side by Side</h3>
              <p>
                Up to four minds.
                <br />
                One better-informed decision.
              </p>
              <span className="dw-card-arrow">
                <ArrowUpRight size={19} />
              </span>
              <Flourish />
            </button>
            <button
              className="dw-launch-card dw-launch-card-rose"
              onClick={() => onNavigate("crosscheck")}
            >
              <span className="dw-launch-num">02 / SCRUTINY</span>
              <ShieldCheck size={28} strokeWidth={1} />
              <h3>Cross-Check</h3>
              <p>
                Inspect the evidence.
                <br />
                Make room for disagreement.
              </p>
              <span className="dw-card-arrow">
                <ArrowUpRight size={19} />
              </span>
              <Flourish />
            </button>
            <button
              className="dw-launch-card dw-launch-card-dark"
              onClick={() => onNavigate("sanctum")}
            >
              <span className="dw-launch-num">03 / DISCRETION</span>
              <Fingerprint size={28} strokeWidth={1} />
              <h3>Enter Sanctum</h3>
              <p>
                Open models.
                <br />A carefully defined boundary.
              </p>
              <span className="dw-card-arrow">
                <ArrowUpRight size={19} />
              </span>
              <Flourish />
            </button>
          </div>
        </>
      ) : (
        <SectionTitle
          number={isSanctum ? "05" : isCompare ? "02" : "01"}
          title={
            isSanctum
              ? "Within the Sanctum."
              : isCompare
                ? "Let the minds differ."
                : "A conversation, considered."
          }
          copy={
            isSanctum
              ? "Explore how sealed open-model routes will work. The preview does not execute inside sealed hardware."
              : isCompare
                ? "One question, independent perspectives. Compare up to four sample model responses."
                : "An interactive sample conversation. No live model request is made."
          }
          action={<Seal small />}
        />
      )}
      {isSanctum && (
        <div className="dw-sanctum-banner">
          <Corners />
          <Fingerprint size={52} strokeWidth={0.8} />
          <div>
            <span className="dw-eyebrow">
              SANCTUM / SEALED OPEN MODELS ONLY
            </span>
            <h2>A boundary you can inspect.</h2>
            <p>
              Production Sanctum verifies hardware attestation, then encrypts
              directly to the host. Verification failure must stop the request.
            </p>
          </div>
          <Badge>Execution unavailable in demo</Badge>
        </div>
      )}
      {(isCompare || isSanctum) && (
        <div className="dw-room-toolbar">
          <div className="dw-selected-models">
            {models.map((m) => (
              <button
                key={m.id}
                className="dw-selected-model"
                onClick={() => onRoute(m)}
              >
                <span className="dw-dot" style={{ background: m.color }} />
                {m.name}
                <span>{m.kind}</span>
              </button>
            ))}
            <button className="dw-button dw-button-small" onClick={onModels}>
              <Plus size={14} />{" "}
              {models.length ? "Edit models" : "Choose models"}
            </button>
          </div>
          {isCompare && (
            <button
              className={`dw-toggle-label ${blind ? "is-on" : ""}`}
              aria-pressed={blind}
              onClick={() => {
                setBlind(!blind);
                setVote(null);
              }}
            >
              {blind ? <EyeOff size={16} /> : <Eye size={16} />} Blind
              comparison <span className="dw-switch" />
            </button>
          )}
        </div>
      )}
      {isCompare && blind && !vote && (
        <p className="dw-inline-note">
          <EyeOff size={15} /> Model identities stay hidden in the answer cards
          until you choose a favorite. The demo shuffles their order for each
          run.
        </p>
      )}
      {!submitted && (
        <div className="dw-prompt-suggestions">
          <span className="dw-eyebrow">A QUESTION TO OPEN THE ROOM</span>
          {SCENARIOS.map((text, index) => (
            <button key={text} onClick={() => samplePrompt(text)}>
              <span>0{index + 1}</span>
              {text}
              <ArrowUpRight size={15} />
            </button>
          ))}
        </div>
      )}
      {submitted && (
        <div className="dw-conversation" aria-live="polite">
          <div className="dw-user-message">
            <span className="dw-avatar dw-avatar-dark">Y</span>
            <div>
              <span className="dw-eyebrow">YOUR QUESTION · LOCAL ONLY</span>
              <p>{submitted}</p>
            </div>
          </div>
          <div className="dw-fixture-note">
            <Sparkles size={15} />
            <span>
              Illustrative responses about trust in an AI workspace. These are
              prewritten examples, not generated answers to your question.
            </span>
          </div>
          <div
            className={`dw-answer-grid ${responseModels.length === 1 ? "is-single" : ""}`}
          >
            {responseModels.map((model, index) => {
              const answer = SAMPLE_ANSWERS[model.id];
              const hidden = isCompare && blind && !vote;
              return (
                <article
                  key={model.id}
                  className={`dw-answer ${vote === model.id ? "is-voted" : ""}`}
                >
                  <div className="dw-answer-head">
                    <span
                      className="dw-model-monogram"
                      style={
                        {
                          "--model-color": hidden ? "#5a5047" : model.color,
                        } as CSSProperties
                      }
                    >
                      {hidden
                        ? String.fromCharCode(65 + index)
                        : model.monogram}
                    </span>
                    <div>
                      <b>
                        {hidden
                          ? `Perspective ${String.fromCharCode(65 + index)}`
                          : model.name}
                      </b>
                      <span>
                        {hidden
                          ? "Identity hidden until your vote"
                          : `${model.family} · sample route`}
                      </span>
                    </div>
                    {!hidden && (
                      <button
                        onClick={() => onRoute(model)}
                        className="dw-route-label"
                      >
                        {model.kind}
                        <ArrowUpRight size={11} />
                      </button>
                    )}
                  </div>
                  <span className="dw-eyebrow">SAMPLE RESPONSE</span>
                  <h3>{answer.heading}</h3>
                  <p>{answer.body}</p>
                  <ul>
                    {answer.points.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  <blockquote>{answer.emphasis}</blockquote>
                  <div className="dw-answer-foot">
                    <span>0 USDC charged</span>
                    {isCompare && (
                      <button
                        onClick={() => {
                          setVote(model.id);
                          onToast(
                            "Preference recorded for this comparison. All identities revealed.",
                          );
                        }}
                      >
                        {vote === model.id ? (
                          <Check size={14} />
                        ) : (
                          <Plus size={14} />
                        )}
                        {vote === model.id ? "Your pick" : "Prefer this"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="dw-conversation-actions">
            <button
              className="dw-button dw-button-red"
              onClick={() =>
                onSave(
                  submitted,
                  responseModels.map((m) => m.id),
                )
              }
            >
              <BookOpen size={16} /> Make a Brief <ArrowRight size={16} />
            </button>
            <button
              className="dw-button"
              onClick={() => onNavigate("crosscheck")}
            >
              <ShieldCheck size={16} /> Cross-Check a claim
            </button>
            <button
              className="dw-button"
              onClick={() => {
                downloadFile(
                  "conclave-sample-conversation.md",
                  `# Conclave sample conversation\n\nLocal demo. No model request made.\n\nQuestion: ${submitted}\n\n${responseModels.map((m) => `## ${m.name}\n${SAMPLE_ANSWERS[m.id].body}`).join("\n\n")}`,
                  "text/markdown",
                );
                onToast("Sample conversation exported.");
              }}
            >
              <ArrowDownToLine size={16} /> Export
            </button>
          </div>
        </div>
      )}
      <form className="dw-composer" onSubmit={submit}>
        <div className="dw-composer-label">
          <span className="dw-eyebrow">
            {isCompare
              ? "ASK THE ROOM"
              : isSanctum
                ? "WRITE WITHIN THE BOUNDARY"
                : "START A CONVERSATION"}
          </span>
          <span>
            <ShieldCheck size={13} /> Browser pattern guard
          </span>
        </div>
        <textarea
          ref={composerRef}
          aria-label="Your question"
          maxLength={8000}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setGuard(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={
            isCompare
              ? "Give a question to a few different minds…"
              : "What deserves a second perspective?"
          }
          rows={3}
        />
        <div className="dw-composer-bottom">
          <div className="dw-composer-controls">
            <button
              className="dw-model-button"
              type="button"
              onClick={onModels}
            >
              <Sparkles size={14} />
              {models[0]?.name || "Choose a model"}
              {models.length > 1 && isCompare ? ` + ${models.length - 1}` : ""}
              <ChevronDown size={13} />
            </button>
            <label className="dw-privacy-select">
              <Shield size={13} />
              <select
                value={privacy}
                aria-label="Minimum privacy route"
                disabled={isSanctum}
                onChange={(e) => onPrivacy(e.target.value as Privacy)}
              >
                <option value="all">All routes</option>
                <option value="private">Zero retention or sealed</option>
                <option value="sealed">Sealed only</option>
              </select>
            </label>
          </div>
          <button
            className="dw-send"
            type="submit"
            disabled={
              !prompt.trim() ||
              !models.length ||
              (isCompare && models.length < 2)
            }
            aria-label="Show sample responses"
          >
            <span>Explore sample</span>
            <ArrowUpRight size={19} />
          </button>
        </div>
        {guard && (
          <div className="dw-guard-alert" role="alert">
            <ShieldCheck size={20} />
            <div>
              <b>
                {guard.type === "key"
                  ? "Key Guard paused this message."
                  : guard.type === "secret"
                    ? "Leak Guard paused this message."
                    : "Review this pasted instruction."}
              </b>
              <p>{guard.message}</p>
              {guard.redacted && (
                <button
                  type="button"
                  onClick={() => {
                    setPrompt(guard.redacted!);
                    setGuard(null);
                    onToast(
                      "Matched secret replaced locally. Review the message before submitting.",
                    );
                  }}
                >
                  Replace matched text with [REDACTED SECRET]{" "}
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
          </div>
        )}
        {!models.length && (
          <p className="dw-guard-alert">
            No eligible route selected. Choose a permitted model; strict routing
            will not fall back.
          </p>
        )}
        <div className="dw-composer-caption">
          <span>
            No network request. No funds spent. Never paste real secrets.
          </span>
          <span>⌘ / Ctrl + Enter</span>
        </div>
      </form>
      <div className="dw-room-bottom">
        <span>
          <ShieldCheck size={14} /> Limited pattern demo. Some secrets will not
          be detected.
        </span>
        <button
          onClick={() => {
            samplePrompt("API_KEY=demo_secret_value_12345");
          }}
        >
          Try the guard with a dummy secret <ArrowUpRight size={12} />
        </button>
      </div>
    </>
  );
}

const ROUTE_LEVELS = [
  {
    level: "LOCAL",
    name: "On your device",
    icon: Code2,
    visibility: "Your local companion processes the prompt on-device.",
    retention: "Controlled by the local application and device.",
    boundary:
      "No Conclave credits or server receipt. Requires a local companion; unavailable here.",
  },
  {
    level: "ZDR",
    name: "Zero-retention route",
    icon: EyeOff,
    visibility: "The provider sees prompt content while processing it.",
    retention: "Zero retention must be supported by current provider terms.",
    boundary:
      "Training use, legal holds, jurisdiction and evidence still need explicit verification.",
  },
  {
    level: "IDENTITY_HIDDEN_CONTENT_VISIBLE",
    name: "Hosted, identity hidden",
    icon: Globe2,
    visibility:
      "The model provider sees the content; Conclave’s relay hides the user identity from that provider.",
    retention: "Varies by the actual provider route.",
    boundary:
      "This is not content privacy. Retention and training terms must be read before sending.",
  },
  {
    level: "SEALED",
    name: "Sealed hardware",
    icon: Fingerprint,
    visibility: "Model execution occurs inside hardware-sealed infrastructure.",
    retention: "Defined by a verified host policy, not by the label alone.",
    boundary:
      "Hardware sealing alone does not establish browser-to-host encryption. Physical and vendor-level limits remain.",
  },
  {
    level: "E2EE_TO_SEALED",
    name: "Encrypted to sealed",
    icon: LockKeyhole,
    visibility:
      "The browser encrypts to the verified sealed host; the relay sees ciphertext and routing metadata.",
    retention: "Must be bound to the verified host and its declared policy.",
    boundary:
      "Sanctum’s intended route for open models only. Invalid or unavailable attestation must refuse execution.",
  },
  {
    level: "UNVERIFIED",
    name: "Evidence unavailable",
    icon: Shield,
    visibility: "Privacy behavior has not been verified.",
    retention: "Unknown until supporting terms and evidence are checked.",
    boundary:
      "No privacy guarantee follows from a model name. Strict policies must refuse this route.",
  },
];

function RouteLibrary({
  privacy,
  onPrivacy,
  onRoute,
  onModels,
}: {
  privacy: Privacy;
  onPrivacy: (p: Privacy) => void;
  onRoute: (m: DemoModel) => void;
  onModels: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = MODELS.filter((m) =>
    `${m.name} ${m.kind} ${m.level}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <SectionTitle
        number="06"
        title="Nothing leaves without a label."
        copy="A model name is not a privacy policy. Inspect what each route means before choosing where a question goes."
        action={
          <button className="dw-button dw-button-red" onClick={onModels}>
            Choose sample routes <ArrowRight size={16} />
          </button>
        }
      />
      <div className="dw-route-library-intro">
        <ShieldCheck size={31} strokeWidth={1} />
        <p>
          Every route in this preview is an <b>unverified example</b>. The
          levels below describe the intended production contract; no provider
          terms or host attestations have been verified here.
        </p>
      </div>
      <div className="dw-route-levels">
        {ROUTE_LEVELS.map(
          (
            { level, name, icon: Icon, visibility, retention, boundary },
            index,
          ) => (
            <details className="dw-route-level" key={level}>
              <summary>
                <span className="dw-route-level-number">0{index + 1}</span>
                <Icon size={22} strokeWidth={1} />
                <div>
                  <span className="dw-eyebrow">{level}</span>
                  <h2>{name}</h2>
                </div>
                <Plus size={16} />
              </summary>
              <div className="dw-route-level-copy">
                <dl>
                  <div>
                    <dt>Who sees the content?</dt>
                    <dd>{visibility}</dd>
                  </div>
                  <div>
                    <dt>Retention</dt>
                    <dd>{retention}</dd>
                  </div>
                  <div>
                    <dt>The important boundary</dt>
                    <dd>{boundary}</dd>
                  </div>
                </dl>
              </div>
            </details>
          ),
        )}
      </div>
      <div className="dw-room-heading">
        <div>
          <h2>Inspect a sample Route Card.</h2>
          <p>
            Availability and prices are illustrative. Nothing is routed to a
            real provider.
          </p>
        </div>
      </div>
      <section className="dw-panel">
        <div className="dw-route-library-filters">
          <label className="dw-search">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a model or route level…"
              aria-label="Find a Route Card"
            />
          </label>
          <label className="dw-route-floor">
            <span className="dw-eyebrow">YOUR PRIVACY FLOOR</span>
            <select
              value={privacy}
              onChange={(e) => onPrivacy(e.target.value as Privacy)}
            >
              <option value="all">All sample routes</option>
              <option value="private">Zero retention or sealed</option>
              <option value="sealed">Sealed open models only</option>
            </select>
          </label>
        </div>
        <div className="dw-table-scroll">
          <table className="dw-table">
            <thead>
              <tr>
                <th>Model / family</th>
                <th>Intended level</th>
                <th>Policy</th>
                <th aria-label="Inspect route" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.name}</b>
                    <small>{m.family} · sample</small>
                  </td>
                  <td>
                    <span className="dw-route-level-code">{m.level}</span>
                    <small>Evidence: unverified</small>
                  </td>
                  <td>
                    <Badge>
                      {allowedRoute(m, privacy)
                        ? "Allowed in demo"
                        : "Blocked by policy"}
                    </Badge>
                  </td>
                  <td>
                    <button
                      className="dw-icon-button"
                      aria-label={`Inspect ${m.name} Route Card`}
                      onClick={() => onRoute(m)}
                    >
                      <ArrowUpRight size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <p className="dw-inline-note">No sample routes match “{query}”.</p>
        )}
        <p className="dw-inline-note">
          The live router must apply verified evidence to the chosen minimum and
          fail closed. This preview only demonstrates the selection controls.
        </p>
      </section>
      <Link href="/docs#routes" className="dw-text-button">
        Read the Route Card specification <ArrowUpRight size={13} />
      </Link>
    </>
  );
}

function RouteModal({
  model,
  onClose,
}: {
  model: DemoModel;
  onClose: () => void;
}) {
  return (
    <Modal title={`${model.name} · Route Card`} onClose={onClose}>
      <div className="dw-route-title">
        <span
          className="dw-model-monogram"
          style={{ "--model-color": model.color } as CSSProperties}
        >
          {model.monogram}
        </span>
        <div>
          <b>{model.family}</b>
          <span>Illustrative provider × model route</span>
        </div>
        <Badge tone={model.kind.toLowerCase()}>{model.kind}</Badge>
      </div>
      <div className="dw-callout">
        <Shield size={18} />
        <p>
          <b>Unverified sample configuration.</b> These fields demonstrate the
          intended Route Card. They are not evidence of this provider’s current
          privacy terms.
        </p>
      </div>
      <dl className="dw-route-details">
        <div>
          <dt>Intended level</dt>
          <dd>{model.level}</dd>
        </div>
        <div>
          <dt>Route status</dt>
          <dd>UNVERIFIED / demo only</dd>
        </div>
        <div>
          <dt>Prompt visibility</dt>
          <dd>
            {model.kind === "Hosted"
              ? "Content visible to the model provider"
              : model.kind === "Private"
                ? "Content visible to provider during processing"
                : "Intended: encrypted to sealed host"}
          </dd>
        </div>
        <div>
          <dt>Retention / training</dt>
          <dd>Not verified</dd>
        </div>
        <div>
          <dt>Jurisdiction / legal hold</dt>
          <dd>Not verified</dd>
        </div>
        <div>
          <dt>Evidence / last verified</dt>
          <dd>No live evidence configured</dd>
        </div>
        <div>
          <dt>Illustrative call estimate</dt>
          <dd>{model.cost.toFixed(3)} USDC · 0 charged in demo</dd>
        </div>
        <div>
          <dt>Attestation</dt>
          <dd>
            {model.kind === "Sealed"
              ? "Not available. No sealed execution has occurred."
              : "Not applicable to this sample route"}
          </dd>
        </div>
      </dl>
      <p className="dw-inline-note">
        Strict mode must refuse an unavailable route or invalid attestation. It
        must never silently choose a lower privacy level.
      </p>
      <Link
        href="/docs#routes"
        className="dw-button dw-button-dark dw-button-full"
      >
        Understand Route Cards <ArrowUpRight size={16} />
      </Link>
    </Modal>
  );
}

function Briefs({
  briefs,
  setBriefs,
  onNavigate,
  onToast,
}: {
  briefs: Brief[];
  setBriefs: (b: Brief[]) => void;
  onNavigate: (v: View) => void;
  onToast: (s: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(briefs[0]?.id || "");
  const [query, setQuery] = useState("");
  const selected = briefs.find((b) => b.id === selectedId) || briefs[0];
  const filtered = briefs.filter((b) =>
    b.title.toLowerCase().includes(query.toLowerCase()),
  );
  const [deleteId, setDeleteId] = useState<string | null>(null);
  return (
    <>
      <SectionTitle
        number="03"
        title="Keep the thinking."
        copy="A question, its perspectives, their differences, and the decision you make."
        action={
          <button
            className="dw-button dw-button-red"
            onClick={() => onNavigate("compare")}
          >
            <Plus size={16} /> New comparison
          </button>
        }
      />
      {!briefs.length ? (
        <EmptyState
          title="A blank page, for now."
          action={
            <button
              className="dw-button dw-button-red"
              onClick={() => onNavigate("compare")}
            >
              Make your first comparison <ArrowRight size={16} />
            </button>
          }
        >
          Save a sample Side by Side result to make your first Brief.
        </EmptyState>
      ) : (
        <div className="dw-brief-layout">
          <aside className="dw-brief-list">
            <label className="dw-search">
              <Search size={16} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a Brief…"
                aria-label="Find a Brief"
              />
            </label>
            {filtered.map((b) => (
              <button
                key={b.id}
                className={b.id === selected?.id ? "is-active" : ""}
                onClick={() => setSelectedId(b.id)}
              >
                <span className="dw-eyebrow">{b.date} / SAMPLE</span>
                <h3>{b.title}</h3>
                <span>
                  {b.models.length} perspectives <ChevronRight size={13} />
                </span>
              </button>
            ))}
            {!filtered.length && (
              <p className="dw-inline-note">No Briefs match this search.</p>
            )}
          </aside>
          {selected && (
            <article className="dw-brief-paper">
              <div className="dw-brief-paper-head">
                <span className="dw-eyebrow">CONCLAVE / THE BRIEF</span>
                <Seal small />
                <Badge>Sample responses</Badge>
              </div>
              <h2>{selected.title}</h2>
              <p className="dw-brief-lede">
                Agreement is a beginning. The differences are where the decision
                lives.
              </p>
              <div className="dw-brief-meta">
                <span>{selected.models.length} model perspectives</span>
                <span>0 USDC charged</span>
                <span>{selected.date}</span>
              </div>
              <h3>01 — The perspectives</h3>
              {selected.models.map((id) => {
                const model = MODELS.find((m) => m.id === id);
                return (
                  model && (
                    <div className="dw-brief-perspective" key={id}>
                      <b>{model.name}</b>
                      <p>{SAMPLE_ANSWERS[id].body}</p>
                    </div>
                  )
                );
              })}
              <h3>02 — Where they meet</h3>
              <div className="dw-table-scroll">
                <table className="dw-table dw-agreement-table">
                  <thead>
                    <tr>
                      <th>Principle</th>
                      {selected.models.map((id) => (
                        <th key={id}>
                          {MODELS.find((m) => m.id === id)?.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      "Explicit privacy boundaries",
                      "Inspectable evidence",
                      "Visible failure states",
                    ].map((claim, index) => (
                      <tr key={claim}>
                        <td>{claim}</td>
                        {selected.models.map((id, m) => (
                          <td key={id}>
                            {index === 2 && m === 1 ? (
                              <span title="Not explicitly discussed">—</span>
                            ) : (
                              <Check size={15} aria-label="Discussed" />
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="dw-inline-note">
                Illustrative agreement matrix, based on the prewritten examples.
                A check means a theme is discussed, not independently verified.
              </p>
              <h3>03 — What remains different</h3>
              <p>
                These samples place different weight on user communication,
                inspectable workflows, and sealed execution. Those are
                complementary priorities, not a universal ranking.
              </p>
              <h3>04 — Sources &amp; limits</h3>
              <p>
                Conclave product overview (sample source). Product
                specifications, not independent evidence.{" "}
                <Link href="/docs">Read the field guide ↗</Link>
              </p>
              <label className="dw-decision-label">
                <span>05 — Your decision</span>
                <textarea
                  rows={3}
                  value={selected.decision}
                  onChange={(e) =>
                    setBriefs(
                      briefs.map((b) =>
                        b.id === selected.id
                          ? { ...b, decision: e.target.value }
                          : b,
                      ),
                    )
                  }
                  placeholder="What will you take from these perspectives?"
                  maxLength={3000}
                />
              </label>
              <p className="dw-print-decision">
                {selected.decision || "No decision recorded."}
              </p>
              <span className="dw-eyebrow">SAVED IN THIS BROWSER</span>
              <div className="dw-brief-actions">
                <button
                  className="dw-button dw-button-dark"
                  onClick={() => {
                    downloadFile(
                      `conclave-brief-${selected.id}.md`,
                      briefMarkdown(selected),
                      "text/markdown",
                    );
                    onToast("Brief exported as Markdown.");
                  }}
                >
                  <ArrowDownToLine size={15} /> Markdown
                </button>
                <button
                  className="dw-button"
                  onClick={() => {
                    downloadFile(
                      `conclave-brief-${selected.id}.json`,
                      JSON.stringify(selected, null, 2),
                      "application/json",
                    );
                    onToast("Brief exported as JSON.");
                  }}
                >
                  JSON
                </button>
                <button className="dw-button" onClick={() => window.print()}>
                  Print / PDF
                </button>
                <button
                  className="dw-icon-button"
                  aria-label="Delete selected Brief"
                  onClick={() => setDeleteId(selected.id)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          )}
        </div>
      )}
      {deleteId && (
        <Modal title="Remove this Brief?" onClose={() => setDeleteId(null)}>
          <p>The selected sample Brief will be removed from this browser.</p>
          <div className="dw-dialog-actions">
            <button className="dw-button" onClick={() => setDeleteId(null)}>
              Keep it
            </button>
            <button
              className="dw-button dw-button-red"
              onClick={() => {
                setBriefs(briefs.filter((b) => b.id !== deleteId));
                setDeleteId(null);
                onToast("Sample Brief removed.");
              }}
            >
              Remove Brief
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

const CHECK_FIXTURES = [
  {
    claim: "Sanctum applies to open models only.",
    verdict: "HOLDS",
    views: ["Supported", "Supported", "Supported"],
    quote: "Applies to open-model routes on sealed hosts only.",
    source: "Conclave product overview · Sanctum",
    text: "All three sample reviewers find the claim supported by the sample product specification.",
  },
  {
    claim: "Frontier providers never see prompts sent to hosted models.",
    verdict: "DOESN’T HOLD",
    views: ["Contradicted", "Contradicted", "Contradicted"],
    quote:
      "Frontier models see your prompt. Route Cards say so; Sanctum covers open models only.",
    source: "Conclave product overview · Honest limits",
    text: "All three sample reviewers find the claim contradicted by the sample product specification.",
  },
  {
    claim: "Guards run locally and detect every possible secret.",
    verdict: "PARTLY",
    views: ["Mixed claims", "Mixed claims", "Mixed claims"],
    quote:
      "Guards are pattern-based. They catch seed phrases and common key formats, not every secret.",
    source: "Conclave product overview · Honest limits",
    text: "“Guards run locally” is supported. “Detect every secret” is contradicted. Different definite results produce PARTLY.",
  },
  {
    claim:
      "Sealed execution alone is sufficient for every team’s privacy needs.",
    verdict: "NO CONSENSUS",
    views: ["Not supported", "Uncertain", "Insufficient scope"],
    quote:
      "Sanctum relies on hardware attestation, which has known limits against physical and vendor-level attacks.",
    source: "Conclave product overview · Honest limits",
    text: "The sample reviewers disagree about the claim’s scope. The system keeps their dissent visible instead of resolving it by majority vote.",
  },
];

function CrossCheck({ onToast }: { onToast: (s: string) => void }) {
  const [fixture, setFixture] = useState(0);
  const [claim, setClaim] = useState(CHECK_FIXTURES[0].claim);
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState("");
  const sample = result === null ? null : CHECK_FIXTURES[result];
  return (
    <>
      <SectionTitle
        number="04"
        title="Question the answer."
        copy="Independent perspectives. Exact source passages. Dissent left intact."
        action={<Seal small />}
      />
      <div className="dw-crosscheck-intro">
        <div className="dw-crosscheck-seal">
          <ShieldCheck size={50} strokeWidth={1} />
        </div>
        <p>
          A check is a record of what independent models found in the evidence.
          It is not a guarantee of truth.
        </p>
        <div className="dw-review-families">
          <span>C / Anthropic</span>
          <span>G / OpenAI</span>
          <span>Q / Qwen</span>
        </div>
      </div>
      <section className="dw-panel">
        <div className="dw-panel-head">
          <h2>A claim worth examining.</h2>
          <Badge>Four illustrative outcomes</Badge>
        </div>
        <fieldset
          className="dw-fixture-tabs"
          aria-label="Sample Cross-Check outcomes"
        >
          {CHECK_FIXTURES.map((f, index) => (
            <button
              className={fixture === index ? "is-active" : ""}
              key={f.verdict}
              aria-pressed={fixture === index}
              onClick={() => {
                setFixture(index);
                setClaim(f.claim);
                setResult(null);
                setError("");
              }}
            >
              {f.verdict}
            </button>
          ))}
        </fieldset>
        <label className="dw-field">
          <span>Claim</span>
          <textarea
            rows={3}
            value={claim}
            onChange={(e) => {
              setClaim(e.target.value);
              setResult(null);
              setError("");
            }}
          />
        </label>
        <div className="dw-check-source">
          <FileText size={17} />
          <span>Evidence: Conclave product overview (sample source)</span>
          <Link href="/docs">
            Inspect source context <ArrowUpRight size={13} />
          </Link>
        </div>
        <div className="dw-panel-actions">
          <span className="dw-muted">
            3 independent families · illustrative estimate 0.018 USDC · 0
            charged
          </span>
          <button
            className="dw-button dw-button-red"
            onClick={() => {
              const guard = scanPrompt(claim);
              if (guard) {
                setError(guard.message);
                return;
              }
              const match = CHECK_FIXTURES.findIndex(
                (f) => f.claim === claim.trim(),
              );
              if (match < 0) {
                setError(
                  "Custom claims require a connected retrieval and model service. Choose a sample outcome to explore this local demo.",
                );
                return;
              }
              setResult(match);
              setError("");
            }}
          >
            Explore sample check <ArrowRight size={16} />
          </button>
        </div>
        {error && (
          <p className="dw-guard-alert" role="alert">
            {error}
          </p>
        )}
      </section>
      {sample && (
        <section className="dw-check-result" aria-live="polite">
          <div className="dw-verdict">
            <span className="dw-eyebrow">
              ILLUSTRATIVE RESULT / NOT A LIVE CHECK
            </span>
            <h2>{sample.verdict}</h2>
            <p>{sample.text}</p>
          </div>
          <div className="dw-review-grid">
            {sample.views.map((v, index) => (
              <article key={`${v}-${index}`}>
                <span className="dw-eyebrow">
                  INDEPENDENT SAMPLE {index + 1}
                </span>
                <h3>{["Claude", "GPT", "Qwen"][index]}</h3>
                <Badge>{v}</Badge>
                <blockquote>“{sample.quote}”</blockquote>
                <span className="dw-muted">{sample.source}</span>
              </article>
            ))}
          </div>
          <p className="dw-inline-note">
            Production checks require ≥ 3 model families and exact quotes in
            stored sources. Invalid quotes are discarded; disagreement is never
            counted as HOLDS.
          </p>
          <button
            className="dw-button dw-button-dark"
            onClick={() => {
              downloadFile(
                "conclave-sample-cross-check.json",
                JSON.stringify(
                  {
                    sample: true,
                    live_check: false,
                    claim: sample.claim,
                    verdict: sample.verdict,
                    reviews: sample.views,
                    quote: sample.quote,
                    source: sample.source,
                    charged_usdc: 0,
                  },
                  null,
                  2,
                ),
                "application/json",
              );
              onToast("Sample check exported.");
            }}
          >
            <ArrowDownToLine size={15} /> Export sample check
          </button>
        </section>
      )}
    </>
  );
}

function Explainer() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"transaction" | "program">("transaction");
  return (
    <>
      <SectionTitle
        number="06"
        title="Read before you sign."
        copy="A plain-language second look at Solana instructions. A preview never signs or executes anything."
      />
      <div className="dw-panel">
        <div className="dw-tab-row">
          <button
            aria-pressed={mode === "transaction"}
            onClick={() => {
              setMode("transaction");
              setResult(false);
              setInput("");
            }}
            className={mode === "transaction" ? "is-active" : ""}
          >
            Transaction explainer
          </button>
          <button
            aria-pressed={mode === "program"}
            onClick={() => {
              setMode("program");
              setResult(false);
              setInput("");
            }}
            className={mode === "program" ? "is-active" : ""}
          >
            Program reader
          </button>
        </div>
        <label className="dw-field">
          <span>
            {mode === "transaction"
              ? "Signature, serialized transaction, Blink, or address"
              : "Program address"}
          </span>
          <textarea
            rows={3}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setResult(false);
              setError("");
            }}
            placeholder={
              mode === "transaction"
                ? "Explore an example transaction…"
                : "Explore an example program…"
            }
          />
        </label>
        <div className="dw-panel-actions">
          <button
            className="dw-text-button"
            onClick={() => {
              setInput(
                mode === "transaction"
                  ? "DEMO: SPL Token SetAuthority"
                  : "DEMO: SPL Token Program",
              );
              setError("");
              setResult(false);
            }}
          >
            Load a safe sample <ArrowUpRight size={13} />
          </button>
          <button
            className="dw-button dw-button-red"
            disabled={!input.trim()}
            onClick={() => {
              const blocked = scanPrompt(input);
              if (blocked) {
                setError(blocked.message);
                return;
              }
              if (
                input !==
                (mode === "transaction"
                  ? "DEMO: SPL Token SetAuthority"
                  : "DEMO: SPL Token Program")
              ) {
                setError(
                  "Can’t decode this input in the local demo. Live parsing, RPC simulation and verified-build lookup are not connected. Load the safe sample to explore the interface.",
                );
                return;
              }
              setError("");
              setResult(true);
            }}
          >
            Read sample <ArrowRight size={16} />
          </button>
        </div>
        {error && (
          <p className="dw-guard-alert" role="alert">
            {error}
          </p>
        )}
      </div>
      {result && (
        <div className="dw-explainer-result" aria-live="polite">
          <div className="dw-risk-card">
            <Shield size={30} />
            <div>
              <span className="dw-eyebrow">SAMPLE FINDING</span>
              <h2>
                {mode === "transaction"
                  ? "This changes who controls a token account."
                  : "A program for token operations."}
              </h2>
              <p>
                {mode === "transaction"
                  ? "The sample instruction sets a new owner authority. That can allow another address to transfer assets from this account."
                  : "This sample interface covers transfers, approvals, authority changes and account closure. Each operation has a different consequence."}
              </p>
            </div>
          </div>
          <div className="dw-two-columns">
            <section className="dw-panel">
              <h3>
                {mode === "transaction"
                  ? "Decoded sample instructions"
                  : "Published interface — example"}
              </h3>
              {(mode === "transaction"
                ? [
                    "01 · ComputeBudget: set compute unit limit",
                    "02 · SPL Token: SetAuthority",
                    "03 · New authority: different from current owner",
                  ]
                : [
                    "Transfer · move a token amount",
                    "Approve · authorize a delegate",
                    "SetAuthority · change an account authority",
                  ]
              ).map((line) => (
                <div className="dw-spec-row" key={line}>
                  <span>{line}</span>
                </div>
              ))}
            </section>
            <section className="dw-panel">
              <h3>What has actually been verified?</h3>
              <dl className="dw-route-details">
                <div>
                  <dt>Simulation</dt>
                  <dd>Not run</dd>
                </div>
                <div>
                  <dt>Verified build</dt>
                  <dd>Not checked</dd>
                </div>
                <div>
                  <dt>Balance changes</dt>
                  <dd>Unavailable in demo</dd>
                </div>
                <div>
                  <dt>Signature requested</dt>
                  <dd>None</dd>
                </div>
              </dl>
            </section>
          </div>
          <p className="dw-inline-note">
            This is a fixed educational example, not an analysis of a live
            transaction. Unknown programs must return “can’t decode.”
          </p>
        </div>
      )}
    </>
  );
}

function Chapters({
  members,
  setMembers,
  name,
  onToast,
}: {
  members: Member[];
  setMembers: (m: Member[]) => void;
  name: string;
  onToast: (s: string) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [memberName, setMemberName] = useState("");
  const [role, setRole] = useState<Member["role"]>("Member");
  const [cap, setCap] = useState("25");
  const [guards, setGuards] = useState(true);
  const [sealed, setSealed] = useState(false);
  const [helperDraft, setHelperDraft] = useState(false);
  return (
    <>
      <SectionTitle
        number="07"
        title="A shared purpose."
        copy="One Chapter. Clear roles, visible allowances, and room to think together."
        action={
          <button
            className="dw-button dw-button-red"
            onClick={() => setAddOpen(true)}
          >
            <Plus size={16} /> Add demo member
          </button>
        }
      />
      <div className="dw-chapter-banner">
        <Corners />
        <div>
          <span className="dw-eyebrow">CHAPTER NO. 001</span>
          <h2>{name}</h2>
          <p>
            A local team preview. No multisig or encrypted room is connected.
          </p>
        </div>
        <Seal />
        <div className="dw-chapter-count">
          <b>{members.length.toString().padStart(2, "0")}</b>
          <span>MEMBERS</span>
        </div>
      </div>
      <div className="dw-three-stats">
        <div>
          <span>ILLUSTRATIVE SHARED CAP</span>
          <b>
            250 <small>USDC / month</small>
          </b>
        </div>
        <div>
          <span>PROPOSED SEAT PRICE</span>
          <b>
            9 <small>USDC / member + usage</small>
          </b>
        </div>
        <div>
          <span>SQUADS MULTISIG</span>
          <b className="dw-stat-text">
            Not connected <LockKeyhole size={18} />
          </b>
        </div>
      </div>
      <section className="dw-panel">
        <div className="dw-panel-head">
          <h2>The people in the room.</h2>
          <Badge>Local demo members</Badge>
        </div>
        <div className="dw-table-scroll">
          <table className="dw-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Monthly cap / USDC</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td aria-label={`Member ${member.name}`}>
                    <span className="dw-member-cell">
                      <span className="dw-avatar">
                        {member.name[0]?.toUpperCase()}
                      </span>
                      <b>{member.name}</b>
                    </span>
                  </td>
                  <td>
                    <select
                      aria-label={`Role for ${member.name}`}
                      value={member.role}
                      disabled={member.id === 1}
                      onChange={(e) => {
                        setMembers(
                          members.map((m) =>
                            m.id === member.id
                              ? { ...m, role: e.target.value as Member["role"] }
                              : m,
                          ),
                        );
                        onToast("Demo member role saved locally.");
                      }}
                    >
                      <option>Owner</option>
                      <option>Officer</option>
                      <option>Member</option>
                      <option>Guest</option>
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={`Monthly cap for ${member.name}`}
                      type="number"
                      min="0"
                      max="10000"
                      value={member.cap}
                      onChange={(e) =>
                        setMembers(
                          members.map((m) =>
                            m.id === member.id
                              ? {
                                  ...m,
                                  cap: Math.min(
                                    10000,
                                    Math.max(0, Number(e.target.value)),
                                  ),
                                }
                              : m,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    {member.id !== 1 && (
                      <button
                        className="dw-icon-button"
                        aria-label={`Remove ${member.name}`}
                        onClick={() => {
                          setMembers(members.filter((m) => m.id !== member.id));
                          onToast("Demo member removed from this browser.");
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dw-inline-note">
          Owner: controls the Chapter · Officer: manages rooms · Member: uses
          assigned allowance · Guest: limited participation. Demo role changes
          do not create real access permissions.
        </p>
      </section>
      <div className="dw-two-columns">
        <section className="dw-panel">
          <h2>Room policy.</h2>
          <label
            className="dw-setting-row"
            htmlFor="chapter-guards"
            aria-label="Mandatory browser guards"
          >
            <span>
              <b>Mandatory browser guards</b>
              <small>Model the Chapter’s proposed policy</small>
            </span>
            <input
              id="chapter-guards"
              type="checkbox"
              checked={guards}
              onChange={(e) => setGuards(e.target.checked)}
            />
          </label>
          <label
            className="dw-setting-row"
            htmlFor="chapter-sealed"
            aria-label="Sanctum-only room"
          >
            <span>
              <b>Sanctum-only room</b>
              <small>Restrict a future room to sealed open models</small>
            </span>
            <input
              id="chapter-sealed"
              type="checkbox"
              checked={sealed}
              onChange={(e) => setSealed(e.target.checked)}
            />
          </label>
          <p className="dw-inline-note">
            These switches preview room policy only. The demo composer’s limited
            pattern guard remains enabled.
          </p>
        </section>
        <section className="dw-panel">
          <h2>A helper with boundaries.</h2>
          <p>
            Proposed rulebook: inspect the monthly budget and draft a funding
            proposal. Never sign or execute a transaction.
          </p>
          <button
            className="dw-button"
            onClick={() => setHelperDraft(!helperDraft)}
          >
            <FileText size={15} />{" "}
            {helperDraft ? "Hide proposal draft" : "Preview proposal draft"}
          </button>
          {helperDraft && (
            <pre className="dw-code">{`DRAFT · DEMO ONLY\nChapter: ${name}\nAction: review monthly usage allowance\nRequested cap: 250 USDC / month\nDestination: not configured\nExecution: requires multisig owners\nNo transaction constructed or signed.`}</pre>
          )}
        </section>
      </div>
      {addOpen && (
        <Modal
          title="Invite another perspective."
          onClose={() => setAddOpen(false)}
        >
          <p>
            Add a local sample member to explore Chapter controls. No invitation
            will be sent.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!memberName.trim()) return;
              setMembers([
                ...members,
                {
                  id: Date.now(),
                  name: memberName.trim(),
                  role,
                  cap: Number(cap),
                },
              ]);
              setMemberName("");
              setAddOpen(false);
              onToast("Demo member added locally. No invitation sent.");
            }}
          >
            <label className="dw-field">
              <span>Display name</span>
              <input
                required
                maxLength={50}
                value={memberName}
                onChange={(e) => setMemberName(e.target.value)}
                placeholder="e.g. Jordan"
              />
            </label>
            <label className="dw-field">
              <span>Role</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Member["role"])}
              >
                <option>Officer</option>
                <option>Member</option>
                <option>Guest</option>
              </select>
            </label>
            <label className="dw-field">
              <span>Monthly demo allowance / USDC</span>
              <input
                type="number"
                required
                min="0"
                max="10000"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
              />
            </label>
            <button
              className="dw-button dw-button-red dw-button-full"
              type="submit"
            >
              Add local member <Plus size={16} />
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}

const RECEIPTS = [
  {
    id: "sample-0003",
    model: "Claude",
    level: "IDENTITY_HIDDEN_CONTENT_VISIBLE",
    route_id: "sample-claude-hosted",
    kind: "Side by Side",
    estimate: 0.012,
    date: "2026-10-06 14:32",
    hold_ref: "sample-hold-003",
  },
  {
    id: "sample-0002",
    model: "GPT",
    level: "IDENTITY_HIDDEN_CONTENT_VISIBLE",
    route_id: "sample-gpt-hosted",
    kind: "Side by Side",
    estimate: 0.009,
    date: "2026-10-06 14:32",
    hold_ref: "sample-hold-002",
  },
  {
    id: "sample-0001",
    model: "Qwen",
    level: "E2EE_TO_SEALED",
    route_id: "sample-qwen-sealed",
    kind: "Sanctum",
    estimate: 0.005,
    date: "2026-10-06 14:32",
    hold_ref: "sample-hold-001",
  },
];

function Receipts({ onToast }: { onToast: (s: string) => void }) {
  const [filter, setFilter] = useState("all");
  const [receipt, setReceipt] = useState<(typeof RECEIPTS)[number] | null>(
    null,
  );
  const [verification, setVerification] = useState("");
  const rows = RECEIPTS.filter((r) => filter === "all" || r.kind === filter);
  return (
    <>
      <SectionTitle
        number="08"
        title="Leave a paper trail."
        copy="Every live paid call should carry its route, actual cost, and a signed receipt."
        action={
          <button
            className="dw-button"
            onClick={() => {
              downloadFile(
                "conclave-sample-receipts.json",
                JSON.stringify(
                  {
                    sample: true,
                    signed: false,
                    charged_usdc: 0,
                    receipts: rows,
                  },
                  null,
                  2,
                ),
                "application/json",
              );
              onToast("Sample receipt data exported.");
            }}
          >
            <ArrowDownToLine size={16} /> Export JSON
          </button>
        }
      />
      <div className="dw-receipt-callout">
        <ReceiptText size={35} strokeWidth={1} />
        <div>
          <h2>An auditable idea. A clearly labelled example.</h2>
          <p>
            These sample records have no signature, attestation, or Solana
            inclusion proof. There have been no paid calls in this workspace.
          </p>
        </div>
      </div>
      <section className="dw-panel">
        <div className="dw-panel-head">
          <h2>Example activity</h2>
          <select
            value={filter}
            aria-label="Filter receipts"
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All examples</option>
            <option>Side by Side</option>
            <option>Sanctum</option>
          </select>
        </div>
        <div className="dw-table-scroll">
          <table className="dw-table">
            <thead>
              <tr>
                <th>Sample receipt</th>
                <th>Model / mode</th>
                <th>Illustrative cost</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.id}</b>
                    <small>{r.date}</small>
                  </td>
                  <td>
                    {r.model}
                    <small>{r.kind}</small>
                  </td>
                  <td>
                    {r.estimate.toFixed(3)} USDC<small>0 charged</small>
                  </td>
                  <td>
                    <Badge>Unsigned sample</Badge>
                  </td>
                  <td>
                    <button
                      className="dw-icon-button"
                      aria-label={`Inspect receipt ${r.id}`}
                      onClick={() => {
                        setReceipt(r);
                        setVerification("");
                      }}
                    >
                      <ArrowUpRight size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="dw-two-columns">
        <section className="dw-panel">
          <span className="dw-eyebrow">INTENDED RECEIPT LIFECYCLE</span>
          <h2>Hold. Capture. Release.</h2>
          <p>
            A live call first reserves its maximum cost, captures its actual
            usage, and releases unused funds. A failed request releases its
            hold.
          </p>
        </section>
        <section className="dw-panel">
          <span className="dw-eyebrow">PUBLIC VERIFICATION / PLANNED</span>
          <h2>Proof without the prompt.</h2>
          <p>
            Production receipts are designed for signature and Merkle inclusion
            checks against hourly roots on Solana. This preview has no deployed
            verifier.
          </p>
        </section>
      </div>
      {receipt && (
        <Modal title="Inspect the receipt." onClose={() => setReceipt(null)}>
          <dl className="dw-route-details">
            <div>
              <dt>ID</dt>
              <dd>{receipt.id}</dd>
            </div>
            <div>
              <dt>Model / route</dt>
              <dd>
                {receipt.model} / {receipt.route_id}
              </dd>
            </div>
            <div>
              <dt>Intended route level</dt>
              <dd>{receipt.level}</dd>
            </div>
            <div>
              <dt>Example timestamp</dt>
              <dd>{receipt.date}</dd>
            </div>
            <div>
              <dt>Hold reference</dt>
              <dd>{receipt.hold_ref}</dd>
            </div>
            <div>
              <dt>Actual charged cost</dt>
              <dd>0 USDC</dd>
            </div>
            <div>
              <dt>Signature / attestation</dt>
              <dd>None · sample record</dd>
            </div>
            <div>
              <dt>On-chain inclusion</dt>
              <dd>None · no transaction</dd>
            </div>
          </dl>
          <button
            className="dw-button dw-button-dark dw-button-full"
            onClick={() =>
              setVerification(
                "Cannot verify: this example has no Ed25519 signature, attestation bundle or on-chain Merkle proof. No verification succeeded.",
              )
            }
          >
            Check verification status <ShieldCheck size={16} />
          </button>
          {verification && (
            <output className="dw-guard-alert">{verification}</output>
          )}
        </Modal>
      )}
    </>
  );
}

function Balance({
  onTopup,
  onNavigate,
}: {
  onTopup: () => void;
  onNavigate: (v: View) => void;
}) {
  return (
    <>
      <SectionTitle
        number="09"
        title="One balance. Every perspective."
        copy="Prepaid usage, visible estimates, and an itemized record of every live call."
      />
      <div className="dw-balance-grid">
        <section className="dw-balance-card">
          <Corners />
          <span className="dw-eyebrow">
            ILLUSTRATIVE BALANCE / NOT REAL FUNDS
          </span>
          <h2>
            24.68 <span>USDC</span>
          </h2>
          <p>One room. No stack of subscriptions.</p>
          <button className="dw-button dw-button-dark" onClick={onTopup}>
            <Plus size={16} /> Preview a top-up
          </button>
          <Seal />
        </section>
        <section className="dw-panel dw-balance-facts">
          <h2>Usage, without the mystery.</h2>
          <dl className="dw-route-details">
            <div>
              <dt>Actual demo spending</dt>
              <dd>0 USDC</dd>
            </div>
            <div>
              <dt>Real funds held</dt>
              <dd>None</dd>
            </div>
            <div>
              <dt>Connected wallet</dt>
              <dd>None</dd>
            </div>
            <div>
              <dt>Pending transactions</dt>
              <dd>None</dd>
            </div>
          </dl>
          <button
            className="dw-text-button"
            onClick={() => onNavigate("receipts")}
          >
            Inspect sample receipts <ArrowUpRight size={13} />
          </button>
        </section>
      </div>
      <div className="dw-room-heading">
        <div>
          <h2>A clear cost of thinking.</h2>
          <p>
            Proposed pricing, subject to change. Not a live quote.
          </p>
        </div>
      </div>
      <div className="dw-pricing-cards">
        <article>
          <span className="dw-eyebrow">STANDARD ROUTES</span>
          <h3>
            Cost + <em>5%</em>
          </h3>
          <p>
            Pay for the model usage behind each call, with a visible service
            fee.
          </p>
        </article>
        <article>
          <span className="dw-eyebrow">SANCTUM</span>
          <h3>
            Cost + <em>15%</em>
          </h3>
          <p>Open-model execution on verified sealed hosts, when available.</p>
        </article>
        <article>
          <span className="dw-eyebrow">CHAPTERS</span>
          <h3>
            9 <em>USDC</em>
          </h3>
          <p>Per member, per month, plus usage. Shared budgets and roles.</p>
        </article>
      </div>
      <p className="dw-inline-note">
        Credits represent prepaid usage and are not tradeable. USDC remains
        subject to issuer controls. Live top-ups, settlement and withdrawal
        require backend integration.
      </p>
    </>
  );
}

function Topup({ onClose }: { onClose: () => void }) {
  const [amount, setAmount] = useState("25");
  const [method, setMethod] = useState("USDC");
  const [review, setReview] = useState(false);
  return (
    <Modal title="Fuel the next thought." onClose={onClose}>
      <p>
        Preview the proposed top-up flow. No wallet is connected and no payment
        can be made here.
      </p>
      <div className="dw-tab-row">
        {["USDC", "SOL"].map((m) => (
          <button
            key={m}
            aria-pressed={method === m}
            className={method === m ? "is-active" : ""}
            onClick={() => {
              setMethod(m);
              setReview(false);
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setReview(true);
        }}
      >
        <label className="dw-field">
          <span>Desired balance credit / USDC</span>
          <input
            type="number"
            min="1"
            max="10000"
            step="0.01"
            required
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setReview(false);
            }}
          />
        </label>
        <div className="dw-amount-options">
          {["10", "25", "50", "100"].map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={amount === a}
              className={amount === a ? "is-active" : ""}
              onClick={() => {
                setAmount(a);
                setReview(false);
              }}
            >
              {a} USDC
            </button>
          ))}
        </div>
        <p className="dw-inline-note">
          {method === "SOL"
            ? "A live SOL top-up needs a fresh conversion quote and a slippage cap before approval. This preview has no exchange-rate quote."
            : "A live USDC top-up is credited only after Solana finalization."}
        </p>
        <button
          type="submit"
          className="dw-button dw-button-red dw-button-full"
        >
          Review demo top-up <ArrowRight size={16} />
        </button>
      </form>
      {review && (
        <output className="dw-topup-review">
          <b>
            Preview: {Number(amount).toFixed(2)} USDC via {method}
          </b>
          <p>
            Payment unavailable: wallet, quote service and deposit watcher are
            not connected. Your sample balance has not changed.
          </p>
        </output>
      )}
    </Modal>
  );
}

function Developers({ onToast }: { onToast: (s: string) => void }) {
  const [tool, setTool] = useState("conclave_ask");
  const [cap, setCap] = useState("1");
  const [revoked, setRevoked] = useState(false);
  const config = {
    demo: true,
    server: "NOT_CONFIGURED",
    tool,
    max_cost_usdc: Number(cap),
    enabled: !revoked,
    note: "Template only. Requires a deployed server and authenticated account.",
  };
  return (
    <>
      <SectionTitle
        number="10"
        title="A second opinion, anywhere."
        copy="Explore the planned MCP pack and capped access for your developer tools."
      />
      <div className="dw-developer-banner">
        <Code2 size={42} strokeWidth={1} />
        <div>
          <span className="dw-eyebrow">MCP / DEVELOPER PREVIEW</span>
          <h2>Bring another mind to your editor.</h2>
          <p>
            Proposed tools for Claude Code, Cursor, Windsurf, Cline and
            Continue. No client or server is connected in this preview.
          </p>
        </div>
      </div>
      <div className="dw-two-columns">
        <section className="dw-panel">
          <h2>A permission you can cap.</h2>
          <label className="dw-field">
            <span>Tool</span>
            <select value={tool} onChange={(e) => setTool(e.target.value)}>
              <option>conclave_ask</option>
              <option>conclave_compare</option>
              <option>conclave_crosscheck</option>
              <option>conclave_explain_tx</option>
            </select>
          </label>
          <label className="dw-field">
            <span>Illustrative per-call cap / USDC</span>
            <input
              type="number"
              value={cap}
              min="0.01"
              max="100"
              step="0.01"
              onChange={(e) => setCap(e.target.value)}
            />
          </label>
          <div className="dw-spec-row">
            <KeyRound size={19} />
            <span>
              <b>Sample access policy</b>
              <small>No credential is generated</small>
            </span>
            <Badge>{revoked ? "Revoked locally" : "Preview only"}</Badge>
          </div>
          <button
            className="dw-button"
            onClick={() => {
              setRevoked(!revoked);
              onToast(
                revoked
                  ? "Sample policy enabled locally."
                  : "Sample policy revoked locally. No live credentials were affected.",
              );
            }}
          >
            {revoked ? "Restore sample policy" : "Revoke sample policy"}
          </button>
        </section>
        <section className="dw-panel">
          <h2>Your configuration draft.</h2>
          <pre className="dw-code">{JSON.stringify(config, null, 2)}</pre>
          <button
            className="dw-button dw-button-dark"
            onClick={() => {
              if (
                !Number.isFinite(Number(cap)) ||
                Number(cap) < 0.01 ||
                Number(cap) > 100
              ) {
                onToast("Choose a cap between 0.01 and 100 USDC.");
                return;
              }
              downloadFile(
                "conclave-mcp-draft.json",
                JSON.stringify(config, null, 2),
                "application/json",
              );
              onToast(
                "Configuration draft downloaded. A real server must be configured.",
              );
            }}
          >
            <ArrowDownToLine size={15} /> Download draft
          </button>
        </section>
      </div>
      <section className="dw-panel">
        <h2>A deliberately narrow API.</h2>
        <p>
          The initial planned developer API supports chat completions with Route
          Card headers. Authentication, per-tool caps and revocation must be
          connected to the live service before use.
        </p>
        <Link className="dw-text-button" href="/docs#developers">
          Read the implementation boundaries <ArrowUpRight size={13} />
        </Link>
      </section>
    </>
  );
}

function Settings({
  name,
  onName,
  privacy,
  onPrivacy,
  quietMotion,
  setQuietMotion,
  onReset,
  onIdentity,
  onToast,
}: {
  name: string;
  onName: (s: string) => void;
  privacy: Privacy;
  onPrivacy: (p: Privacy) => void;
  quietMotion: boolean;
  setQuietMotion: (b: boolean) => void;
  onReset: () => void;
  onIdentity: () => void;
  onToast: (s: string) => void;
}) {
  const [draftName, setDraftName] = useState(name);
  return (
    <>
      <SectionTitle
        number="11"
        title="Set the terms of your room."
        copy="Your defaults, your privacy floor, and your local demonstration data."
      />
      <div className="dw-settings-stack">
        <section className="dw-panel">
          <span className="dw-eyebrow">01 / IDENTITY</span>
          <h2>A name for the Chapter.</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draftName.trim()) {
                onName(draftName.trim());
                onToast("Workspace name saved in this browser.");
              }
            }}
          >
            <label className="dw-field">
              <span>Workspace name</span>
              <input
                required
                maxLength={50}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
              />
            </label>
            <div className="dw-panel-actions">
              <button
                type="button"
                className="dw-text-button"
                onClick={onIdentity}
              >
                Wallet &amp; passkey status <ArrowUpRight size={13} />
              </button>
              <button type="submit" className="dw-button dw-button-dark">
                Save name <Check size={15} />
              </button>
            </div>
          </form>
        </section>
        <section className="dw-panel">
          <span className="dw-eyebrow">02 / PRIVACY</span>
          <h2>Your floor. Never a suggestion.</h2>
          <label className="dw-field">
            <span>Minimum sample route level</span>
            <select
              value={privacy}
              onChange={(e) => onPrivacy(e.target.value as Privacy)}
            >
              <option value="all">
                All routes — hosted content is visible to provider
              </option>
              <option value="private">Zero retention or sealed routes</option>
              <option value="sealed">Sealed open models only</option>
            </select>
          </label>
          <p className="dw-inline-note">
            Changing your floor removes ineligible selections. If none remain,
            the demo refuses to proceed until you choose a permitted route.
          </p>
          <div className="dw-setting-row">
            <span>
              <b>Browser pattern guard</b>
              <small>Limited demonstration of key and secret detection</small>
            </span>
            <Badge>Always on in demo</Badge>
          </div>
          <Link href="/docs#guards" className="dw-text-button">
            Understand guard limits <ArrowUpRight size={13} />
          </Link>
        </section>
        <section className="dw-panel">
          <span className="dw-eyebrow">03 / ATMOSPHERE</span>
          <h2>A quieter room.</h2>
          <label
            className="dw-setting-row"
            htmlFor="quiet-motion"
            aria-label="Reduce decorative motion"
          >
            <span>
              <b>Reduce decorative motion</b>
              <small>System reduced-motion preference is also respected</small>
            </span>
            <input
              id="quiet-motion"
              type="checkbox"
              checked={quietMotion}
              onChange={(e) => setQuietMotion(e.target.checked)}
            />
          </label>
        </section>
        <section className="dw-panel">
          <span className="dw-eyebrow">04 / LOCAL DATA</span>
          <h2>Leave no demo behind.</h2>
          <p>
            Only demo preferences, sample Chapter members and saved Briefs are
            stored in this browser. Messages in the composer are not saved
            between sessions.
          </p>
          <button className="dw-button" onClick={onReset}>
            <Trash2 size={15} /> Reset local demo
          </button>
        </section>
      </div>
    </>
  );
}
