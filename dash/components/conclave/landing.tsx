'use client';

import Link from '@/components/site-link';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
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
import { ContractAddress } from "./contract-address";
import { useT } from "@/lib/i18n";
import { LanguageToggle } from "@/components/language-toggle";

const questions = [
  ["What is Conclave?", "A multi-model AI workspace built around one connected project. Compare perspectives, develop ideas and carry the useful work into the next step. Use Claude, GPT, Gemini, Grok, DeepSeek, Qwen and Llama with your project context today."],
  ["What is Second Look?", "The next Conclave expansion: an AI second opinion for Solana social traders. The roadmap covers token checks, trader research, wallet records, personal reminders and an optional Guarded Wallet, with mobile and agent access."],
  ["How does Conclave handle privacy?", "Hosted model requests pass through an inference gateway and the selected model’s host, which process the submitted content. Their retention and training policies vary. Conclave’s direction is to make those choices clear before you send."],
  ["Which models are part of the experience?", "Claude, GPT, Gemini, Grok, DeepSeek, Qwen and Llama are available for live text requests. Sample conversations remain available to explore before signing in."],
  ["How does pricing work?", "Pricing is usage-based. Review the quote before approving a model request, then see the settled cost. Add native USDC on Solana mainnet to your Common Purse; credit appears after finalized payment verification. Conclave shows the estimated network fee and any account-creation rent before you sign."],
  ["How does wallet sign-in work?", "Sign in with a supported Solana wallet by approving an account-ownership message. It does not transfer funds. A USDC top-up requires a separate transaction that you review and approve in your wallet."],
  ["What can I explore today?", "Use live chat with seven model families, Projects, Canvas, the Library and saved decisions. Fund usage through the Common Purse with Solana mainnet USDC. Studio, Second Look and the other roadmap tools are not released yet."],
];

function ComparePreview() {
  const t = useT();
  const [selected, setSelected] = useState(0);
  const prompts = [
    'Explain the trade-offs.',
    'Find the blind spots.',
    'Challenge my thinking.',
  ];
  const answers = [
    ['A practical perspective', 'A questioning perspective'],
    ['What may be missing', 'Where the assumptions break'],
    ['The strongest argument', 'A useful counterargument'],
  ];
  return (
    <OrnateFrame className="council-preview">
      <div className="preview-bar">
        <span>
          <i className="status-dot" /> {t('THE COUNCIL ROOM')}
        </span>
        <span>{t('INTERACTIVE SAMPLE · 02 VOICES')}</span>
      </div>
      <fieldset
        className="prompt-switcher"
        aria-label={t('Example comparison prompts')}
      >
        {prompts.map((p, i) => (
          <button
            key={p}
            onClick={() => setSelected(i)}
            aria-pressed={selected === i}
          >
            {t(p)}
          </button>
        ))}
      </fieldset>
      <div className="sample-prompt">
        <span>{t('YOU')}</span>
        <p>{t(prompts[selected])}</p>
        <ArrowUpRight size={20} />
      </div>
      <div className="sample-answers" key={selected}>
        <article>
          <div className="answer-label">
            <span className="model-sigil">✺</span> {t('PERSPECTIVE I')}{' '}
            <small>{t('Sample A')}</small>
          </div>
          <h4>{t(answers[selected][0])}</h4>
          <p>
            {t(
              selected === 0
                ? 'Start with the outcome. A shared workspace reduces friction, but each model carries a different set of assumptions.'
                : selected === 1
                  ? 'An elegant answer can still hide a missing premise. Look for what the evidence does not cover before accepting the conclusion.'
                  : 'A single coherent argument is useful. Break it into claims, trace its sources, and decide which assumptions you are willing to accept.',
            )}
          </p>
          <div className="answer-lines">
            <i />
            <i />
            <i />
          </div>
          <span className="answer-foot">{t('01 / EXPLORE THE CASE')}</span>
        </article>
        <article>
          <div className="answer-label">
            <span className="model-sigil">✥</span> {t('PERSPECTIVE II')}{' '}
            <small>{t('Sample B')}</small>
          </div>
          <h4>{t(answers[selected][1])}</h4>
          <p>
            {t(
              selected === 0
                ? 'The alternative is worth hearing. Compare the actual evidence, not the confidence of the answer. Agreement is a signal, not a guarantee.'
                : selected === 1
                  ? 'Ask what would change the conclusion. Distinguish a lack of evidence from evidence against a claim. Keep uncertainty visible.'
                  : 'A useful dissent does more than disagree. It identifies the weak premise and explains what evidence would resolve the difference.',
            )}
          </p>
          <div className="answer-lines">
            <i />
            <i />
            <i />
          </div>
          <span className="answer-foot">{t('02 / QUESTION THE CASE')}</span>
        </article>
      </div>
      <div className="preview-bottom">
        <span>
          <Check size={14} />{' '}
          {t('Different perspectives. One decision: yours.')}
        </span>
        <Link href="/dashboard#chat">
          {t('TRY SIDE BY SIDE')} <ArrowUpRight size={17} />
        </Link>
      </div>
    </OrnateFrame>
  );
}

function CostPreview() {
  const t = useT();
  const [kind, setKind] = useState(0);
  const types = ["Text", "Image", "Video"];
  const details = ["The model, input and response length shape the quote.", "Planned for Studio: the model, image size and output count shape the quote.", "Planned for Studio: the model, duration and resolution shape the quote."];
  return (
    <div className="cost-preview cost-preview--dynamic">
      <div className="cost-options">{types.map((type, index) => <button key={type} aria-pressed={kind === index} onClick={() => setKind(index)}>{t(type)}</button>)}</div>
      <div className="cost-total"><span>{t("By usage")}<small>{t("ONE CLEAR QUOTE")}</small></span><p>{t.rich("Your chosen model.{br}Your requested output.", { br: <br /> })}</p></div>
      <p className="fineprint">{t("{detail} Review it before a paid request.", { detail: t(details[kind]) })}</p>
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
  const t = useT();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const scroll = () => setScrolled(window.scrollY > 100);
    scroll();
    window.addEventListener('keydown', close);
    window.addEventListener('scroll', scroll, { passive: true });
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('scroll', scroll);
    };
  }, []);
  return (
    <header className={`conclave-nav ${scrolled ? 'nav-scrolled' : ''}`}>
      <Brand />
      <nav
        className={open ? 'nav-links is-open' : 'nav-links'}
        aria-label={t('Main navigation')}
      >
        <Link href="#manifesto" onClick={() => setOpen(false)}>
          {t('The idea')}
        </Link>
        <Link href="#possibilities" onClick={() => setOpen(false)}>
          {t('Possibilities')}
        </Link>
        <Link href="#workspace" onClick={() => setOpen(false)}>
          {t('Workspace')}
        </Link>
        <Link href="/whitepaper">{t("White paper")} <ArrowUpRight size={12} /></Link>
        <Link href="/roadmap">{t("Roadmap")} <ArrowUpRight size={12} /></Link>
      </nav>
      <div className="nav-actions">
        <LanguageToggle className="nav-language" />
        <button
          className="motion-button"
          onClick={onMotion}
          aria-label={still ? t('Play animations') : t('Pause animations')}
        >
          {still ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <Link className="nav-enter" href="/dashboard">
          {t('ENTER CONCLAVE')} <ArrowUpRight size={16} />
        </Link>
        <button
          className="menu-button"
          aria-label={open ? t('Close navigation') : t('Open navigation')}
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
  const t = useT();
  const [still, setStill] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loader, setLoader] = useState(true);
  const [filmError, setFilmError] = useState(false);
  const filmDialog = useRef<HTMLDialogElement>(null);
  const film = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotionPreference = () => setStill(media.matches);
    media.addEventListener('change', updateMotionPreference);
    const frame = requestAnimationFrame(() => {
      setStill(media.matches);
      setLoaded(true);
    });
    const timeout = window.setTimeout(() => setLoader(false), 1100);
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            observer.unobserve(entry.target);
          }
        }),
      { threshold: 0.12 },
    );
    document
      .querySelectorAll('[data-reveal]')
      .forEach((node) => observer.observe(node));
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      media.removeEventListener('change', updateMotionPreference);
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
    document.addEventListener('visibilitychange', updatePlayback);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', updatePlayback);
    };
  }, [still]);
  const openFilm = () => {
    filmDialog.current?.showModal();
    const video = filmDialog.current?.querySelector('video');
    void video?.play().catch(() => {});
  };
  return (
    <div
      className={`conclave-site conclave-site--contract-top ${loaded ? "loaded" : ""} ${still ? "motion-paused" : ""}`}
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
          <span className="loader-word">
            <Wordmark />
          </span>
          <p>{t('ASSEMBLING DIFFERENT PERSPECTIVES')}</p>
          <div className="loader-line" />
          <button onClick={() => setLoader(false)}>
            {t('Enter now')} <ArrowUpRight size={14} />
          </button>
        </output>
      )}
      <Link className="skip-link" href="#main-content">
        {t('Skip to content')}
      </Link>
      <aside className="cl-contract-strip" aria-label={t("Conclave contract address")}>
        <ContractAddress />
      </aside>
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
              <i className="status-dot" /> {t('A MULTI-MODEL AI WORKSPACE')}
            </span>
            <span>{t('BUILT FOR SOLANA / VOL. 001')}</span>
          </div>
          <p className="hero-description" data-scroll-drift data-drift-y="35">
            <span className="hero-description__bracket">[</span>
            <span className="hero-description__copy">
              <span>{t('BRING DIFFERENT MINDS TO THE TABLE.')}</span>
              <span>{t('ONE ANSWER, OR FOUR SIDE BY SIDE.')}</span>
              <span>{t('ASK AGAIN. THE CONTEXT FOLLOWS.')}</span>
              <span>{t('THE FINAL WORD IS ALWAYS YOURS.')}</span>
            </span>
            <span className="hero-description__bracket hero-description__bracket--end">
              ]
            </span>
          </p>
          {!still ? (
            <AnimatedHeroTitle />
          ) : (
            <h1 className="hero-title">
              {t.rich('MANY{br}GREAT MINDS.{br}ONE COMMON{br}GROUND.', {
                br: <br />,
              })}
            </h1>
          )}
          <div className="hero-entry">
            <Link href="/dashboard">
              {t('OPEN THE CHAT')} <ArrowUpRight size={20} />
            </Link>
          </div>
          <Link
            href="#manifesto"
            className="scroll-seal"
            aria-label={t('Discover Conclave')}
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
                  {t('SCROLL TO CONVENE · SCROLL TO CONVENE ·')}{' '}
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
                <span className="eyebrow">{t('02 / THE POSSIBILITIES')}</span>
                <h2>
                  {t.rich('A different kind{br}of {intelligence}', {
                    br: <br />,
                    intelligence: <em>{t('intelligence.')}</em>,
                  })}
                </h2>
              </div>
              <p>
                {t.rich(
                  'More than an answer box.{br}A place to see the whole picture.',
                  { br: <br /> },
                )}
              </p>
            </div>
            <div className="feature-deck">
              <OrnateFrame className="feature-card card-red">
                <div className="card-number">
                  I <span>{t('THE COUNCIL')}</span>
                  <EngravedIcon name="gauntlet" />
                </div>
                <UiMorph kind="council" paused={still} />
                <h3>
                  {t.rich('Many minds.{br}{view}', {
                    br: <br />,
                    view: <em>{t('A clearer view.')}</em>,
                  })}
                </h3>
                <p>
                  {t(
                    'Compare up to four models side by side. Choose the answer before you see the name.',
                  )}
                </p>
                <Link href="/dashboard#chat">
                  {t('GATHER THE COUNCIL')} <ArrowUpRight size={17} />
                </Link>
              </OrnateFrame>
              <OrnateFrame className="feature-card card-ink">
                <div className="card-number">
                  II <span>{t('THE BOUNDARY')}</span>
                  <EngravedIcon name="shield" />
                </div>
                <UiMorph kind="boundary" paused={still} />
                <h3>
                  {t.rich('Know what{br}{boundary}', {
                    br: <br />,
                    boundary: <em>{t('leaves the room.')}</em>,
                  })}
                </h3>
                <p>
                  {t(
                    'Every request travels through one hosted provider to the model’s maker. The boundary is named before you type.',
                  )}
                </p>
                <Link href="/dashboard#chat">
                  {t('SEE THE BOUNDARY')} <ArrowUpRight size={17} />
                </Link>
              </OrnateFrame>
              <OrnateFrame className="feature-card card-cream">
                <div className="card-number">
                  III <span>{t('THE COMMON PURSE')}</span>
                  <EngravedIcon name="coins" />
                </div>
                <UiMorph kind="purse" paused={still} />
                <h3>
                  {t.rich('One balance.{br}{clarity}', {
                    br: <br />,
                    clarity: <em>{t('No blind spots.')}</em>,
                  })}
                </h3>
                <p>
                  {t("A prepaid credit balance, a quote before you run, and the settled cost afterwards. Top up with native USDC on Solana mainnet; credit follows finalized payment verification.")}
                </p>
                <Link href="/dashboard#chat">
                  {t('EXPLORE THE BALANCE')} <ArrowUpRight size={17} />
                </Link>
              </OrnateFrame>
            </div>
          </section>
          <section
            id="motion-archive"
            className="film-section film-chapter section-pad"
            aria-label={t('Conclave horse film')}
          >
            <div className="film-editorial-heading" data-reveal>
              <div>
                <span className="eyebrow">
                  {t('INTERLUDE / COLLECTIVE INSTINCT')}
                </span>
                <span className="film-edition">
                  {t('CONCLAVE MOTION ARCHIVE — 001')}
                </span>
              </div>
              <h2>
                {t.rich('Different by nature.{br}{company}', {
                  br: <br />,
                  company: <em>{t('Stronger in company.')}</em>,
                })}
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
                <span>{t.rich('DIFFERENT{br}MINDS.', { br: <br /> })}</span>
                <small>CONCLAVE / 001</small>
              </div>
              <div
                className="film-shutter film-shutter-right"
                aria-hidden="true"
              >
                <span>{t.rich('SHARED{br}DIRECTION.', { br: <br /> })}</span>
                <small>{t('A STUDY IN COLLECTIVE INSTINCT')}</small>
              </div>
              <button
                className="film-screen-play"
                onClick={openFilm}
                aria-label={t('Watch the 15-second Conclave film')}
              >
                <Play size={21} fill="currentColor" />
                <span>{t('PLAY FILM')}</span>
              </button>
              <span className="film-screen-time" aria-hidden="true">
                {t('00:15 / FOUR PERSPECTIVES')}
              </span>
            </div>
            <div className="film-editorial-caption">
              <span>{t('01—04 / THE COUNCIL IN MOTION')}</span>
              <p>{t('No single perspective sees everything.')}</p>
              <button onClick={openFilm}>
                {filmError
                  ? t('OPEN THE MOTION ARCHIVE')
                  : t('WATCH FULL FILM')}
                <ArrowUpRight size={16} />
              </button>
            </div>
          </section>
          <section id="workspace" className="workspace-section section-pad">
            <div className="section-heading" data-reveal>
              <div>
                <span className="eyebrow">
                  {t('03 / A ROOM FOR BETTER QUESTIONS')}
                </span>
                <h2>
                  {t.rich('Pull up {chair}', {
                    chair: <em>{t('a chair.')}</em>,
                  })}
                </h2>
              </div>
              <p>
                {t.rich(
                  'Ask once. Explore the differences.{br}Leave with a decision you can explain.',
                  { br: <br /> },
                )}
              </p>
            </div>
            <ComparePreview />
            <div className="workflow-notes">
              <div>
                <EngravedIcon name="gauntlet" />
                <h4>{t("Assemble")}</h4>
                <p>{t("Choose up to four models for your question.")}</p>
              </div>
              <div>
                <EngravedIcon name="key" />
                <h4>{t('Examine')}</h4>
                <p>{t('Compare the arguments and the dissent.')}</p>
              </div>
              <div>
                <EngravedIcon name="scroll" />
                <h4>{t('Decide')}</h4>
                <p>{t('Ask the follow-up. The context comes along.')}</p>
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
                alt={t('A black and ivory halftone armored gauntlet')}
                loading="lazy"
              />
              <div className="guard-art-caption">
                <span>{t('YOUR INFORMATION')}</span>
                <span>{t('YOUR BOUNDARIES')}</span>
              </div>
              <Ornament />
            </div>
            <div className="guard-copy" data-reveal>
              <span className="eyebrow">{t('04 / THE TERMS OF TRUST')}</span>
              <h2>
                {t.rich('Plain terms,{br}before {typing}', {
                  br: <br />,
                  typing: <em>{t('you type.')}</em>,
                })}
              </h2>
              <p>
                {t("Clear information supports better choices. Hosted requests travel through an inference gateway to the selected model’s host, which process the content you submit.")}
              </p>
              <div className="privacy-rows">
                <Link href="/docs#routes">
                  <EngravedIcon name="key" />
                  <div>
                    <h4>{t("Where requests go")}</h4>
                    <p>{t("Understand the path from your question to its answer.")}</p>
                  </div>
                  <ArrowUpRight />
                </Link>
                <Link href="/docs#guards">
                  <EngravedIcon name="gauntlet" />
                  <div>
                    <h4>{t("Thoughtful request controls")}</h4>
                    <p>{t("In development: review sensitive content before sending.")}</p>
                  </div>
                  <ArrowUpRight />
                </Link>
                <Link href="/dashboard#chat">
                  <EngravedIcon name="shield" />
                  <div>
                    <h4>{t("Access on your terms")}</h4>
                    <p>{t("Sign in with a supported Solana wallet.")}</p>
                  </div>
                  <ArrowUpRight />
                </Link>
              </div>
              <p className="guard-note">
                {t("Hosted content is shared with the gateway and model host. Retention and training policies vary by service.")}
              </p>
            </div>
          </section>
          <section className="chapters-section section-pad">
            <div className="section-index">
              <span>{t('05 / CHAPTERS · PLANNED')}</span>
              <span>{t('FOR PEOPLE WHO THINK TOGETHER')}</span>
            </div>
            <OrnateFrame className="chapters-frame">
              <div className="chapter-flower" aria-hidden="true">
                <span>✳</span>
                <span>✳</span>
                <span>✳</span>
              </div>
              <span className="eyebrow">{t("THE NEXT CHAPTER")}</span>
              <h2>
                {t.rich('A common purpose.{br}{conclave}', {
                  br: <br />,
                  conclave: <em>{t('A Conclave of your own.')}</em>,
                })}
              </h2>
              <p>
                {t("Chapters will bring your team into one Conclave: shared rooms, defined roles, and a clear allowance for every member. A shared space to develop ideas and move good work forward.")}
              </p>
              <Link className="ink-button" href="/dashboard#chat">
                {t('OPEN THE CHAT TODAY')} <ArrowUpRight size={18} />
              </Link>
              <div className="chapter-roles">
                <span>{t('TEAMS')}</span>
                <b>✧</b>
                <span>{t('ROLES')}</span>
                <b>✧</b>
                <span>{t('ALLOWANCES')}</span>
                <b>✧</b>
                <span>{t('PLANNED')}</span>
              </div>
            </OrnateFrame>
          </section>
          <section className="economics-section section-pad" id="economics">
            <div className="economics-copy" data-reveal>
              <span className="eyebrow">{t('06 / CLEAR ACCOUNTS')}</span>
              <h2>
                {t.rich('Pay for the thought.{br}{lines}', {
                  br: <br />,
                  lines: <em>{t('See every line.')}</em>,
                })}
              </h2>
              <p>
                {t("Pricing follows your model and usage. Review the quote before the request and the settled cost afterwards. Fund your prepaid balance with native USDC on Solana mainnet.")}
              </p>
              <Link className="text-link" href="/docs#billing">
                {t('READ THE BILLING PRINCIPLES')} <ArrowUpRight size={17} />
              </Link>
            </div>
            <OrnateFrame className="economics-card">
              <div className="receipt-top">
                <EngravedIcon name="coins" />
                <span>{t('THE COMMON PURSE')}</span>
              </div>
              <CostPreview />
              <Ornament />
            </OrnateFrame>
          </section>
          <section className="roadmap-section section-pad" id="roadmap">
            <div className="section-heading">
              <div>
                <span className="eyebrow">{t('07 / THE ROAD AHEAD')}</span>
                <h2>
                  {t.rich('Built in {chapters}', {
                    chapters: <em>{t('chapters.')}</em>,
                  })}
                </h2>
              </div>
              <p>
                {t.rich("The workspace. Second Look. A wallet built around your rules.{br}{roadmap}", {
                  br: <br />,
                  roadmap: <Link href="/roadmap">{t("Explore the full roadmap ↗")}</Link>,
                })}
              </p>
            </div>
            <div className="roadmap-line">
              {[
                {
                  n: "I",
                  title: "Think & create",
                  state: "THE AI WORKSPACE",
                  items: [
                    "Multi-model Chat, Concur and a shared account",
                    "Canvas, Studio image and video, and Briefs",
                    "Specialist agents, Chapters and shared projects",
                  ],
                },
                {
                  n: "II",
                  title: "Take a second look",
                  state: "THE NEXT EXPANSION",
                  items: [
                    "Before You Buy and Signature Firewall",
                    "Follow Check, True P&L and tax records",
                    "Cool Head, Why It Moved and Exit Plans",
                  ],
                },
                {
                  n: "III",
                  title: "Make it yours",
                  state: "THE WIDER VISION",
                  items: [
                    "Optional Guarded Wallet with on-chain limits",
                    "Rooms with timestamped calls and outcomes",
                    "Telegram, mobile, API, MCP and wider chain research",
                  ],
                },
              ].map((item) => (
                <details
                  className="roadmap-stop"
                  key={item.n}
                  open={item.n === 'I'}
                >
                  <summary>
                    <span className="milestone-seal">{item.n}</span>
                    <span className="eyebrow">{t(item.state)}</span>
                    <h3>{t(item.title)}</h3>
                    <Plus className="detail-plus" size={19} />
                  </summary>
                  <ul>
                    {item.items.map((i) => (
                      <li key={i}>{t(i)}</li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </section>
          <section className="faq-section section-pad" id="questions">
            <div className="faq-heading">
              <Ornament />
              <span className="eyebrow">{t('08 / BEFORE YOU ENTER')}</span>
              <h2>
                {t.rich('A few{br}{questions}', {
                  br: <br />,
                  questions: <em>{t('good questions.')}</em>,
                })}
              </h2>
              <Link href="/docs" className="text-link">
                {t('OPEN THE FIELD GUIDE')} <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="faq-list">
              {questions.map(([q, a], i) => (
                <details key={q}>
                  <summary>
                    <span>{String(i + 1).padStart(2, '0')}</span>
                    {t(q)}
                    <Plus className="faq-plus" size={19} />
                    <Minus className="faq-minus" size={19} />
                  </summary>
                  <p>{t(a)}</p>
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
        aria-label={t('Conclave motion archive')}
        onClose={() => filmDialog.current?.querySelector('video')?.pause()}
      >
        <div className="film-dialog-top">
          <span>{t('CONCLAVE / MOTION ARCHIVE 001')}</span>
          <button
            aria-label={t('Close film')}
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
        {filmError && (
          <p>{t('The film is not available in this preview yet.')}</p>
        )}
      </dialog>
    </div>
  );
}
