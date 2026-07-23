"use client";

import Link from "@/components/site-link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowDown,
  Menu,
  X,
  Play,
  Pause,
  Check,
  Plus,
  Minus,
} from "lucide-react";
import { EngravedHero } from "./engraved-hero";
import { AnimatedHeroTitle } from "@/components/animated-hero-title";
import { HeroScrollDrift } from "@/components/hero-scroll-drift";
import { Brand, Ornament, OrnateFrame } from "./ornament";
import { Wordmark } from "./wordmark";
import { Closing } from "./closing";
import { AboutFilm } from "./about-film";
import { UiMorph } from "./ui-morph";
import { EngravedIcon } from "./engraved-icon";
import { HalftoneVideo } from "./halftone-video";
import { FilmMorph } from "./film-morph";
import { ModelBanner } from "./model-banner";

const questions = [
  [
    "What is Conclave?",
    "A multi-model AI chat built for Solana. Ask seven models in one room, take a single answer or compare up to four side by side, and follow up with the context intact. Sign in with a Solana wallet or a passkey and start asking.",
  ],
  [
    "Does every model have the same privacy?",
    "No. Each model is hosted by its own maker, and every request travels through one inference provider rather than running on your device. Treat anything you type as shared with that provider and the model's host. Per-route privacy labels and strict refusal are planned, not yet available.",
  ],
  [
    "Which models can I ask?",
    "Seven today: Claude, GPT, Gemini, Grok, DeepSeek, Qwen and Llama, all reached through one provider. Pick one model, mention several with @ to compare them, or choose Auto and let the room pick a model for the question. Model names belong to their makers.",
  ],
  [
    "How do credits work?",
    "You prepay one credit balance in US dollars. Before a request runs you see a quote, and the quote shows a 5% platform fee on top of model usage. The actual cost is settled afterwards against that quote. USDC deposits on Solana are planned and not yet available.",
  ],
  [
    "Can Conclave sign or execute transactions?",
    "No. Signing in with a wallet means signing a short message that proves the account is yours; the message says it authorizes no transaction or payment. Conclave never asks you to sign a transaction to chat, and no model can act on-chain for you.",
  ],
  [
    "Can I use the workspace now?",
    "Yes. Open the chat, sign in with a wallet or a passkey, and ask. Single answers, side-by-side comparison, @mentions, Auto routing and follow-ups are live. Chapters for teams, Cross-Check, Briefs and media generation are planned and not part of this release.",
  ],
];

function ComparePreview() {
  const [selected, setSelected] = useState(0);
  const prompts = [
    "Explain the trade-offs.",
    "Find the blind spots.",
    "Challenge my thinking.",
  ];
  const answers = [
    ["A practical perspective", "A questioning perspective"],
    ["What may be missing", "Where the assumptions break"],
    ["The strongest argument", "A useful counterargument"],
  ];
  return (
    <OrnateFrame className="council-preview">
      <div className="preview-bar">
        <span>
          <i className="status-dot" /> THE COUNCIL ROOM
        </span>
        <span>INTERACTIVE SAMPLE · 02 VOICES</span>
      </div>
      <fieldset
        className="prompt-switcher"
        aria-label="Example comparison prompts"
      >
        {prompts.map((p, i) => (
          <button
            key={p}
            onClick={() => setSelected(i)}
            aria-pressed={selected === i}
          >
            {p}
          </button>
        ))}
      </fieldset>
      <div className="sample-prompt">
        <span>YOU</span>
        <p>{prompts[selected]}</p>
        <ArrowUpRight size={20} />
      </div>
      <div className="sample-answers" key={selected}>
        <article>
          <div className="answer-label">
            <span className="model-sigil">✺</span> PERSPECTIVE I{" "}
            <small>Sample A</small>
          </div>
          <h4>{answers[selected][0]}</h4>
          <p>
            {selected === 0
              ? "Start with the outcome. A shared workspace reduces friction, but each model carries a different set of assumptions."
              : selected === 1
                ? "An elegant answer can still hide a missing premise. Look for what the evidence does not cover before accepting the conclusion."
                : "A single coherent argument is useful. Break it into claims, trace its sources, and decide which assumptions you are willing to accept."}
          </p>
          <div className="answer-lines">
            <i />
            <i />
            <i />
          </div>
          <span className="answer-foot">01 / EXPLORE THE CASE</span>
        </article>
        <article>
          <div className="answer-label">
            <span className="model-sigil">✥</span> PERSPECTIVE II{" "}
            <small>Sample B</small>
          </div>
          <h4>{answers[selected][1]}</h4>
          <p>
            {selected === 0
              ? "The alternative is worth hearing. Compare the actual evidence, not the confidence of the answer. Agreement is a signal, not a guarantee."
              : selected === 1
                ? "Ask what would change the conclusion. Distinguish a lack of evidence from evidence against a claim. Keep uncertainty visible."
                : "A useful dissent does more than disagree. It identifies the weak premise and explains what evidence would resolve the difference."}
          </p>
          <div className="answer-lines">
            <i />
            <i />
            <i />
          </div>
          <span className="answer-foot">02 / QUESTION THE CASE</span>
        </article>
      </div>
      <div className="preview-bottom">
        <span>
          <Check size={14} /> Different perspectives. One decision: yours.
        </span>
        <Link href="/dashboard#chat">
          TRY SIDE BY SIDE <ArrowUpRight size={17} />
        </Link>
      </div>
    </OrnateFrame>
  );
}

function CostPreview() {
  const [usage, setUsage] = useState(20);
  const [sealed, setSealed] = useState(false);
  const fee = 0.05;
  return (
    <div className="cost-preview">
      <div className="cost-options">
        <button aria-pressed={!sealed} onClick={() => setSealed(false)}>
          One answer
        </button>
        <button aria-pressed={sealed} onClick={() => setSealed(true)}>
          Side by side
        </button>
      </div>
      <label htmlFor="usage">
        ILLUSTRATIVE MODEL USAGE <span>{usage.toFixed(2)} USD</span>
      </label>
      <input
        id="usage"
        type="range"
        min="5"
        max="100"
        step="5"
        value={usage}
        onChange={(e) => setUsage(Number(e.target.value))}
      />
      <div className="cost-total">
        <span>
          {(usage * (1 + fee)).toFixed(2)}
          <small>USD</small>
        </span>
        <p>
          Model usage + {fee * 100}%<br />
          One visible total.
        </p>
      </div>
      <p className="fineprint">
        Illustrative amounts, not a quote. No deposit or charge.
      </p>
    </div>
  );
}

function LandingNav({
  still,
  onMotion,
}: {
  still: boolean;
  onMotion: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const scroll = () => setScrolled(window.scrollY > 100);
    scroll();
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", scroll, { passive: true });
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", scroll);
    };
  }, []);
  return (
    <header className={`conclave-nav ${scrolled ? "nav-scrolled" : ""}`}>
      <Brand />
      <nav
        className={open ? "nav-links is-open" : "nav-links"}
        aria-label="Main navigation"
      >
        <Link href="#manifesto" onClick={() => setOpen(false)}>
          The idea
        </Link>
        <Link href="#possibilities" onClick={() => setOpen(false)}>
          Possibilities
        </Link>
        <Link href="#workspace" onClick={() => setOpen(false)}>
          Workspace
        </Link>
        <Link href="/docs">
          Field guide <ArrowUpRight size={12} />
        </Link>
      </nav>
      <div className="nav-actions">
        <button
          className="motion-button"
          onClick={onMotion}
          aria-label={still ? "Play animations" : "Pause animations"}
        >
          {still ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <Link className="nav-enter" href="/dashboard">
          ENTER CONCLAVE <ArrowUpRight size={16} />
        </Link>
        <button
          className="menu-button"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <X /> : <Menu />}
        </button>
      </div>
    </header>
  );
}

export function ConclaveLanding() {
  const [still, setStill] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loader, setLoader] = useState(true);
  const [filmError, setFilmError] = useState(false);
  const filmDialog = useRef<HTMLDialogElement>(null);
  const film = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotionPreference = () => setStill(media.matches);
    media.addEventListener("change", updateMotionPreference);
    const frame = requestAnimationFrame(() => {
      setStill(media.matches);
      setLoaded(true);
    });
    const timeout = window.setTimeout(() => setLoader(false), 1100);
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            observer.unobserve(entry.target);
          }
        }),
      { threshold: 0.12 },
    );
    document
      .querySelectorAll("[data-reveal]")
      .forEach((node) => observer.observe(node));
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      media.removeEventListener("change", updateMotionPreference);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    const video = film.current;
    if (!video) return;
    if (still) {
      video.pause();
      return;
    }
    let visible = false;
    const updatePlayback = () => {
      if (visible && !document.hidden) void video.play().catch(() => {});
      else video.pause();
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        updatePlayback();
      },
      { threshold: 0.05 },
    );
    observer.observe(video);
    document.addEventListener("visibilitychange", updatePlayback);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", updatePlayback);
    };
  }, [still]);
  const openFilm = () => {
    filmDialog.current?.showModal();
    const video = filmDialog.current?.querySelector("video");
    void video?.play().catch(() => {});
  };
  return (
    <div
      className={`conclave-site ${loaded ? "loaded" : ""} ${still ? "motion-paused" : ""}`}
    >
      {/* The heading face is preloaded only where it renders above the fold;
          React hoists this link into the document head. */}
      <link
        rel="preload"
        href="/fonts/CaveatBrush-Regular.woff2"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
      />
      {loaded && loader && (
        <output className="entry-loader" aria-live="polite">
          <Ornament />
          <span className="loader-word"><Wordmark /></span>
          <p>ASSEMBLING DIFFERENT PERSPECTIVES</p>
          <div className="loader-line" />
          <button onClick={() => setLoader(false)}>
            Enter now <ArrowUpRight size={14} />
          </button>
        </output>
      )}
      <Link className="skip-link" href="#main-content">
        Skip to content
      </Link>
      <LandingNav still={still} onMotion={() => setStill(!still)} />
      <main className="site-stage" id="main-content">
        <section
          id="top"
          className="site-screen site-screen--horse conclave-hero"
          data-scroll-drift-root
        >
          <EngravedHero paused={still} />
          {!still && <HeroScrollDrift />}
          <div className="hero-edition">
            <span>
              <i className="status-dot" /> A MULTI-MODEL AI WORKSPACE
            </span>
            <span>BUILT FOR SOLANA / VOL. 001</span>
          </div>
          <p className="hero-description" data-scroll-drift data-drift-y="35">
            <span className="hero-description__bracket">[</span>
            <span className="hero-description__copy">
              <span>BRING DIFFERENT MINDS TO THE TABLE.</span>
              <span>ONE ANSWER, OR FOUR SIDE BY SIDE.</span>
              <span>ASK AGAIN. THE CONTEXT FOLLOWS.</span>
              <span>THE FINAL WORD IS ALWAYS YOURS.</span>
            </span>
            <span className="hero-description__bracket hero-description__bracket--end">
              ]
            </span>
          </p>
          {!still ? (
            <AnimatedHeroTitle />
          ) : (
            <h1 className="hero-title">
              MANY
              <br />
              GREAT MINDS.
              <br />
              ONE COMMON
              <br />
              GROUND.
            </h1>
          )}
          <div className="hero-entry">
            <Link href="/dashboard">
              OPEN THE CHAT <ArrowUpRight size={20} />
            </Link>
            <small>SEVEN MODELS · ONE ROOM</small>
          </div>
          <Link
            href="#manifesto"
            className="scroll-seal"
            aria-label="Discover Conclave"
          >
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <defs>
                <path
                  id="seal-text"
                  d="M50 50m-37 0a37 37 0 1 1 74 0a37 37 0 1 1-74 0"
                />
              </defs>
              <text>
                <textPath href="#seal-text">
                  SCROLL TO CONVENE · SCROLL TO CONVENE ·{" "}
                </textPath>
              </text>
            </svg>
            <ArrowDown size={23} />
          </Link>
        </section>
        <div className="conclave-body">
          <div className="scenic-world" aria-hidden="true">
            <div className="scenic-world-image" />
          </div>
          <ModelBanner paused={still} />
          <AboutFilm still={still} />
          <section id="possibilities" className="possibilities section-pad">
            <div className="section-heading" data-reveal>
              <div>
                <span className="eyebrow">02 / THE POSSIBILITIES</span>
                <h2>
                  A different kind
                  <br />
                  of <em>intelligence.</em>
                </h2>
              </div>
              <p>
                More than an answer box.
                <br />A place to see the whole picture.
              </p>
            </div>
            <div className="feature-deck">
              <OrnateFrame className="feature-card card-red">
                <div className="card-number">
                  I <span>THE COUNCIL</span>
                  <EngravedIcon name="gauntlet" />
                </div>
                <UiMorph kind="council" paused={still} />
                <h3>
                  Many minds.
                  <br />
                  <em>A clearer view.</em>
                </h3>
                <p>
                  Compare up to four models side by side. Choose the answer
                  before you see the name.
                </p>
                <Link href="/dashboard#chat">
                  GATHER THE COUNCIL <ArrowUpRight size={17} />
                </Link>
              </OrnateFrame>
              <OrnateFrame className="feature-card card-ink">
                <div className="card-number">
                  II <span>THE BOUNDARY</span>
                  <EngravedIcon name="shield" />
                </div>
                <UiMorph kind="boundary" paused={still} />
                <h3>
                  Know what
                  <br />
                  <em>leaves the room.</em>
                </h3>
                <p>
                  Every request travels through one hosted provider to the
                  model’s maker. The boundary is named before you type.
                </p>
                <Link href="/dashboard#chat">
                  SEE THE BOUNDARY <ArrowUpRight size={17} />
                </Link>
              </OrnateFrame>
              <OrnateFrame className="feature-card card-cream">
                <div className="card-number">
                  III <span>THE COMMON PURSE</span>
                  <EngravedIcon name="coins" />
                </div>
                <UiMorph kind="purse" paused={still} />
                <h3>
                  One balance.
                  <br />
                  <em>No blind spots.</em>
                </h3>
                <p>
                  A prepaid credit balance, a quote before you run, and the
                  settled cost afterwards. USDC deposits are planned.
                </p>
                <Link href="/dashboard#chat">
                  EXPLORE THE BALANCE <ArrowUpRight size={17} />
                </Link>
              </OrnateFrame>
            </div>
          </section>
          <section
            id="motion-archive"
            className="film-section film-chapter section-pad"
            aria-label="Conclave horse film"
          >
            <div className="film-editorial-heading" data-reveal>
              <div>
                <span className="eyebrow">INTERLUDE / COLLECTIVE INSTINCT</span>
                <span className="film-edition">
                  CONCLAVE MOTION ARCHIVE — 001
                </span>
              </div>
              <h2>
                Different by nature.
                <br />
                <em>Stronger in company.</em>
              </h2>
            </div>
            <div className="film-screen" data-reveal>
              <video
                ref={film}
                src="/media/conclave-horse-film.mp4"
                poster="/media/conclave-horse-film-poster.jpg"
                muted
                autoPlay
                loop
                playsInline
                preload="metadata"
                onError={() => setFilmError(true)}
                aria-hidden="true"
              />
              <HalftoneVideo videoRef={film} paused={still} />
              <FilmMorph videoRef={film} paused={still} />
              <div
                className="film-shutter film-shutter-left"
                aria-hidden="true"
              >
                <span>
                  DIFFERENT
                  <br />
                  MINDS.
                </span>
                <small>CONCLAVE / 001</small>
              </div>
              <div
                className="film-shutter film-shutter-right"
                aria-hidden="true"
              >
                <span>
                  SHARED
                  <br />
                  DIRECTION.
                </span>
                <small>A STUDY IN COLLECTIVE INSTINCT</small>
              </div>
              <button
                className="film-screen-play"
                onClick={openFilm}
                aria-label="Watch the 15-second Conclave film"
              >
                <Play size={21} fill="currentColor" />
                <span>PLAY FILM</span>
              </button>
              <span className="film-screen-time" aria-hidden="true">
                00:15 / FOUR PERSPECTIVES
              </span>
            </div>
            <div className="film-editorial-caption">
              <span>01—04 / THE COUNCIL IN MOTION</span>
              <p>No single perspective sees everything.</p>
              <button onClick={openFilm}>
                {filmError ? "OPEN THE MOTION ARCHIVE" : "WATCH FULL FILM"}
                <ArrowUpRight size={16} />
              </button>
            </div>
          </section>
          <section id="workspace" className="workspace-section section-pad">
            <div className="section-heading" data-reveal>
              <div>
                <span className="eyebrow">
                  03 / A ROOM FOR BETTER QUESTIONS
                </span>
                <h2>
                  Pull up <em>a chair.</em>
                </h2>
              </div>
              <p>
                Ask once. Explore the differences.
                <br />
                Leave with a decision you can explain.
              </p>
            </div>
            <ComparePreview />
            <div className="workflow-notes">
              <div>
                <EngravedIcon name="gauntlet" />
                <h4>Assemble</h4>
                <p>Choose your models, or let Auto pick one.</p>
              </div>
              <div>
                <EngravedIcon name="key" />
                <h4>Examine</h4>
                <p>Compare the arguments and the dissent.</p>
              </div>
              <div>
                <EngravedIcon name="scroll" />
                <h4>Decide</h4>
                <p>Ask the follow-up. The context comes along.</p>
              </div>
            </div>
          </section>
          <section className="guard-section section-pad" id="privacy">
            <div className="guard-art halftone-art">
              <Image
                width={1254}
                height={1254}
                sizes="(max-width: 520px) 100vw, 45vw"
                src="/brand/icons/conclave-gauntlet-halftone-v1.png"
                alt="A black and ivory halftone armored gauntlet"
                loading="lazy"
              />
              <div className="guard-art-caption">
                <span>YOUR INFORMATION</span>
                <span>YOUR BOUNDARIES</span>
              </div>
              <Ornament />
            </div>
            <div className="guard-copy" data-reveal>
              <span className="eyebrow">04 / THE TERMS OF TRUST</span>
              <h2>
                Plain terms,
                <br />
                before <em>you type.</em>
              </h2>
              <p>
                Privacy should be legible. Your prompts and the answers travel
                through one inference provider to each model’s host. Nothing
                runs on your device, and Conclave does not pretend otherwise.
              </p>
              <div className="privacy-rows">
                <Link href="/docs#routes">
                  <EngravedIcon name="key" />
                  <div>
                    <h4>Where requests go</h4>
                    <p>One provider, then the model’s host. Nothing local.</p>
                  </div>
                  <ArrowUpRight />
                </Link>
                <Link href="/docs#guards">
                  <EngravedIcon name="gauntlet" />
                  <div>
                    <h4>Guards, planned</h4>
                    <p>Secret checks before sending are not available yet.</p>
                  </div>
                  <ArrowUpRight />
                </Link>
                <Link href="/dashboard#chat">
                  <EngravedIcon name="shield" />
                  <div>
                    <h4>Sign-in, not signing</h4>
                    <p>A wallet signs a message, never a transaction.</p>
                  </div>
                  <ArrowUpRight />
                </Link>
              </div>
              <p className="guard-note">
                Different hosts keep different policies. Treat anything you
                type as shared with the provider and the model’s host.
              </p>
            </div>
          </section>
          <section className="chapters-section section-pad">
            <div className="section-index">
              <span>05 / CHAPTERS · PLANNED</span>
              <span>FOR PEOPLE WHO THINK TOGETHER</span>
            </div>
            <OrnateFrame className="chapters-frame">
              <div className="chapter-flower" aria-hidden="true">
                <span>✳</span>
                <span>✳</span>
                <span>✳</span>
              </div>
              <span className="eyebrow">PLANNED · NOT YET AVAILABLE</span>
              <h2>
                A common purpose.
                <br />
                <em>A Conclave of your own.</em>
              </h2>
              <p>
                Chapters will bring your team into one Conclave: shared rooms,
                defined roles, and a clear allowance for every member. They are
                on the roadmap and not part of this release.
              </p>
              <Link className="ink-button" href="/dashboard#chat">
                OPEN THE CHAT TODAY <ArrowUpRight size={18} />
              </Link>
              <div className="chapter-roles">
                <span>TEAMS</span>
                <b>✧</b>
                <span>ROLES</span>
                <b>✧</b>
                <span>ALLOWANCES</span>
                <b>✧</b>
                <span>PLANNED</span>
              </div>
            </OrnateFrame>
          </section>
          <section className="economics-section section-pad" id="economics">
            <div className="economics-copy" data-reveal>
              <span className="eyebrow">06 / CLEAR ACCOUNTS</span>
              <h2>
                Pay for the thought.
                <br />
                <em>See every line.</em>
              </h2>
              <p>
                No mystery bundle. One prepaid credit balance, a quote before
                each request, and a 5% platform fee shown on that quote.
              </p>
              <Link className="text-link" href="/docs#billing">
                READ THE BILLING PRINCIPLES <ArrowUpRight size={17} />
              </Link>
            </div>
            <OrnateFrame className="economics-card">
              <div className="receipt-top">
                <EngravedIcon name="coins" />
                <span>THE COMMON PURSE</span>
              </div>
              <CostPreview />
              <Ornament />
            </OrnateFrame>
          </section>
          <section className="roadmap-section section-pad" id="roadmap">
            <div className="section-heading">
              <div>
                <span className="eyebrow">07 / THE ROAD AHEAD</span>
                <h2>
                  Built in <em>chapters.</em>
                </h2>
              </div>
              <p>
                The intended path from a considered
                <br />
                workspace to a shared intelligence layer.
              </p>
            </div>
            <div className="roadmap-line">
              {[
                {
                  n: "I",
                  title: "Open the room",
                  state: "AVAILABLE NOW",
                  items: [
                    "Seven models through one provider",
                    "Single answers & four side by side",
                    "Wallet or passkey sign-in & prepaid credits",
                  ],
                },
                {
                  n: "II",
                  title: "Establish trust",
                  state: "PLANNED",
                  items: [
                    "USDC deposits on Solana",
                    "Verified receipts for every call",
                    "Per-route privacy labels & guards",
                  ],
                },
                {
                  n: "III",
                  title: "Think together",
                  state: "PRODUCT DIRECTION",
                  items: [
                    "Chapters & shared allowances",
                    "Evidence-led Cross-Check",
                    "Briefs, Studio media & APIs",
                  ],
                },
              ].map((item) => (
                <details
                  className="roadmap-stop"
                  key={item.n}
                  open={item.n === "I"}
                >
                  <summary>
                    <span className="milestone-seal">{item.n}</span>
                    <span className="eyebrow">{item.state}</span>
                    <h3>{item.title}</h3>
                    <Plus className="detail-plus" size={19} />
                  </summary>
                  <ul>
                    {item.items.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </section>
          <section className="faq-section section-pad" id="questions">
            <div className="faq-heading">
              <Ornament />
              <span className="eyebrow">08 / BEFORE YOU ENTER</span>
              <h2>
                A few
                <br />
                <em>good questions.</em>
              </h2>
              <Link href="/docs" className="text-link">
                OPEN THE FIELD GUIDE <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="faq-list">
              {questions.map(([q, a], i) => (
                <details key={q}>
                  <summary>
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    {q}
                    <Plus className="faq-plus" size={19} />
                    <Minus className="faq-minus" size={19} />
                  </summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </section>
          <Closing />
        </div>
      </main>
      <dialog
        ref={filmDialog}
        className="film-dialog"
        aria-label="Conclave motion archive"
        onClose={() => filmDialog.current?.querySelector("video")?.pause()}
      >
        <div className="film-dialog-top">
          <span>CONCLAVE / MOTION ARCHIVE 001</span>
          <button
            aria-label="Close film"
            onClick={() => filmDialog.current?.close()}
          >
            <X />
          </button>
        </div>
        <video
          src="/media/conclave-horse-film.mp4"
          poster="/media/conclave-horse-film-poster.jpg"
          controls
          playsInline
          muted
          preload="none"
        />
        {filmError && <p>The film is not available in this preview yet.</p>}
      </dialog>
    </div>
  );
}
