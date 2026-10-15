import type { ReactNode } from 'react';
import Link from '@/components/site-link';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Home,
  PanelsTopLeft,
  Route,
} from 'lucide-react';
import { Wordmark } from './wordmark';
import { Ornament, OrnateFrame } from './ornament';
import {
  PublicationMotion,
  RoadmapExplorer,
  SecondLookExplorer,
} from './publication-interactive';
import './publication.css';

type Kind = 'White paper' | 'Roadmap';
function Art({ name, className = '' }: { name: string; className?: string }) {
  return (
    <img
      className={`pub-engraving ${className}`}
      src={`/brand/icons/conclave-${name}-halftone-v1.png`}
      alt=""
      width="700"
      height="700"
      loading={className.includes('pub-hero-object') ? 'eager' : 'lazy'}
    />
  );
}

function Hero({ kind }: { kind: Kind }) {
  const roadmap = kind === 'Roadmap';
  return (
    <section
      className={`pub-hero${roadmap ? ' pub-hero--roadmap' : ''}`}
      aria-labelledby="publication-title"
    >
      <div className="pub-edition">
        <span>CONCLAVE / {roadmap ? 'THE ROAD AHEAD' : 'THE WHITE PAPER'}</span>
        <span>THE WORKSPACE + SECOND LOOK</span>
      </div>
      <div className="pub-hero-layout">
        <div className="pub-hero-copy">
          <span className="pub-micro pub-hero-eyebrow">
            MANY MINDS. YOUR DIRECTION.
          </span>
          <h1 id="publication-title">
            {roadmap ? (
              <>
                The bigger
                <br />
                <em>picture.</em>
              </>
            ) : (
              <>
                Think further.
                <br />
                <em>See more.</em>
              </>
            )}
          </h1>
          <p>
            {roadmap
              ? 'From a council of AI models to a creative workspace, an on-chain second opinion and a wallet built around your rules.'
              : 'One connected platform for different perspectives, creative work and clearer on-chain decisions. This is the Conclave we’re building.'}
          </p>
          <a href={roadmap ? '#release-map' : '#vision'} className="pub-button">
            {roadmap ? 'EXPLORE THE FULL ROADMAP' : 'READ THE VISION'}
            <ArrowDown size={17} />
          </a>
        </div>
        <div className="pub-hero-art" aria-hidden="true">
          <div className="pub-art-world" />
          <div className="pub-art-orbit pub-art-orbit--one" />
          <div className="pub-art-orbit pub-art-orbit--two" />
          <div className="pub-art-cross pub-art-cross--a">+</div>
          <div className="pub-art-cross pub-art-cross--b">+</div>
          <div className="pub-art-sigil">{roadmap ? 'VII' : 'II'}</div>
          <Art
            name={roadmap ? 'gauntlet' : 'shield'}
            className="pub-hero-object"
          />
          <span className="pub-art-tag pub-art-tag--a">
            01 / DIFFERENT PERSPECTIVES
          </span>
          <span className="pub-art-tag pub-art-tag--b">02 / A SECOND LOOK</span>
          <span className="pub-art-tag pub-art-tag--c">
            03 / YOUR OWN RULES
          </span>
          <div className="pub-art-bottom">
            <Ornament />
            <span>THE NEXT CHAPTER OF CONCLAVE</span>
          </div>
        </div>
      </div>
      <div className="pub-hero-foot">
        <span>{roadmap ? '07 RELEASE CHAPTERS' : 'ONE CONNECTED VISION'}</span>
        <span>10 SECOND LOOK TOOLS</span>
        <a href={roadmap ? '/whitepaper' : '/roadmap'}>
          {roadmap ? 'READ THE WHITE PAPER' : 'EXPLORE THE ROADMAP'}
          <ArrowUpRight size={14} />
        </a>
      </div>
    </section>
  );
}

export function Publication({
  kind,
  children,
}: {
  kind: Kind;
  children: ReactNode;
}) {
  return (
    <PublicationMotion>
      <a className="pub-skip" href="#publication-content">
        Skip to content
      </a>
      <header className="pub-nav" id="top">
        <Link href="/" aria-label="Conclave home" className="pub-brand">
          <Wordmark />
          <sup>®</sup>
        </Link>
        <nav aria-label="Conclave publications">
          <Link
            href="/whitepaper"
            aria-current={kind === 'White paper' ? 'page' : undefined}
          >
            White paper
          </Link>
          <Link
            href="/roadmap"
            aria-current={kind === 'Roadmap' ? 'page' : undefined}
          >
            Roadmap
          </Link>
          <Link href="/dashboard" className="pub-nav-enter">
            ENTER CONCLAVE
            <ArrowUpRight size={15} />
          </Link>
        </nav>
      </header>
      <main>
        <Hero kind={kind} />
        <div id="publication-content">{children}</div>
      </main>
      <footer className="pub-footer">
        <div className="pub-footer-world" aria-hidden="true" />
        <Ornament />
        <span className="pub-micro">MANY GREAT MINDS. ONE COMMON GROUND.</span>
        <h2>
          The next move
          <br />
          <em>is yours.</em>
        </h2>
        <Link href="/dashboard" className="pub-button pub-button--white">
          EXPLORE CONCLAVE
          <ArrowUpRight size={18} />
        </Link>
        <div className="pub-footer-bottom">
          <Link href="/">
            <Wordmark />
          </Link>
          <span>© 2026 CONCLAVE</span>
          <Link href={kind === 'Roadmap' ? '/whitepaper' : '/roadmap'}>
            {kind === 'Roadmap' ? 'White paper' : 'Roadmap'}
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </footer>
      <nav className="pub-dock" aria-label="Quick navigation">
        <Link href="/" aria-label="Home">
          <Home size={19} />
          <span>Home</span>
        </Link>
        <i />
        <Link
          href="/whitepaper"
          aria-current={kind === 'White paper' ? 'page' : undefined}
        >
          <BookOpen size={19} />
          <span>White paper</span>
        </Link>
        <Link
          href="/roadmap"
          aria-current={kind === 'Roadmap' ? 'page' : undefined}
        >
          <Route size={19} />
          <span>Roadmap</span>
        </Link>
        <i />
        <Link href="/dashboard">
          <PanelsTopLeft size={19} />
          <span>Workspace</span>
        </Link>
      </nav>
    </PublicationMotion>
  );
}

function Heading({
  number,
  label,
  title,
  children,
}: {
  number: string;
  label: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="pub-section-heading" data-pub-reveal>
      <div>
        <span className="pub-micro">
          {number} / {label}
        </span>
        <h2>{title}</h2>
      </div>
      {children && <p>{children}</p>}
    </div>
  );
}

function WorkspaceJourney() {
  return (
    <div className="pub-journey">
      {[
        {
          n: '01',
          name: 'Chat',
          icon: 'chat',
          action: 'Ask a better question.',
          copy: 'Compare up to four models, explore the differences and carry the conversation forward.',
        },
        {
          n: '02',
          name: 'Canvas',
          icon: 'canvas',
          action: 'Connect the thinking.',
          copy: 'Arrange responses, sources and notes. Branch the directions worth exploring.',
        },
        {
          n: '03',
          name: 'Studio · planned',
          icon: 'studio',
          action: 'Give the idea a form.',
          copy: 'A later release will add image and video models, take comparison and project assets.',
        },
        {
          n: '04',
          name: 'Briefs',
          icon: 'brief',
          action: 'Make the next step clear.',
          copy: 'Bring selected ideas, evidence and decisions into a document you can use.',
        },
      ].map((item) => (
        <div className="pub-journey-step" key={item.name} data-pub-reveal>
          <div className="pub-journey-top">
            <span className="pub-micro">
              {item.n} / {item.name.toUpperCase()}
            </span>
            <ArrowRight size={18} />
          </div>
          <img
            src={`/brand/icons/dashboard-${item.icon}-halftone-v2.webp`}
            alt=""
            width="104"
            height="104"
            loading="lazy"
          />
          <h3>{item.action}</h3>
          <p>{item.copy}</p>
        </div>
      ))}
    </div>
  );
}

export function Whitepaper() {
  return (
    <Publication kind="White paper">
      <nav className="pub-chapter-nav" aria-label="White paper chapters">
        <a href="#vision">The vision</a>
        <a href="#workspace">The workspace</a>
        <a href="#second-look">Second Look</a>
        <a href="#guarded">Your rules</a>
        <a href="#together">Together</a>
        <a href="#principles">The foundation</a>
      </nav>
      <section className="pub-section pub-vision" id="vision">
        <Heading
          number="01"
          label="THE VISION"
          title={
            <>
              Intelligence with
              <br />
              <em>somewhere to go.</em>
            </>
          }
        >
          From the question that starts a project to the decision that moves it
          forward.
        </Heading>
        <div className="pub-vision-body">
          <span className="pub-oversized-mark" aria-hidden="true">
            ✳
          </span>
          <div>
            <p className="pub-lead">
              Conclave brings the conversation, the creative work and the
              evidence into one place.
            </p>
            <p>
              The ambition is a platform you can keep working in. Ask several
              models for a perspective. Turn the useful parts into a canvas, an
              asset or a brief. Bring that same habit of examination to a token,
              a transaction or a trading decision.
            </p>
            <p>
              Second Look extends Conclave into on-chain research: what you’re
              buying, who you’re following, what your activity really costs and
              the rules you want to trade by.
            </p>
          </div>
        </div>
        <div className="pub-thesis">
          <span className="pub-micro">THE COMMON THREAD</span>
          <p>
            More perspectives.
            <br />
            <em>More informed choices.</em>
          </p>
          <Ornament />
        </div>
      </section>
      <section className="pub-section" id="workspace">
        <Heading
          number="02"
          label="THE CONNECTED WORKSPACE"
          title={
            <>
              One project.
              <br />
              <em>Room to grow.</em>
            </>
          }
        >
          Chat, Canvas, Studio and Briefs share a purpose: keep the useful work
          moving, with its context intact.
        </Heading>
        <WorkspaceJourney />
        <div className="pub-editorial-pair">
          <div>
            <span className="pub-micro">THE COUNCIL</span>
            <h3>Let different minds in.</h3>
            <p>
              Compare answers side by side, use blind comparison and ask the
              follow-up that tests an assumption. Concur, the Cross-Check
              workflow, is designed to bring independent reviews and source
              evidence to difficult claims.
            </p>
          </div>
          <div>
            <span className="pub-micro">THE PROJECT</span>
            <h3>Keep what matters close.</h3>
            <p>
              A floating dock connects the tools. Projects, the Library and
              saved decisions give conversations, generated media and briefs a
              shared home. Specialist agents extend that workspace with focused
              capabilities.
            </p>
          </div>
        </div>
      </section>
      <section className="pub-second-look" id="second-look">
        <div className="pub-second-look-banner">
          <div className="pub-micro">
            <span>CONCLAVE / SECOND LOOK</span>
            <span>THE NEXT EXPANSION</span>
          </div>
          <h2>
            Before the click.
            <br />
            <em>A clearer picture.</em>
          </h2>
          <p>
            Ten connected tools for research, perspective and personal control.
          </p>
          <Ornament />
        </div>
        <div className="pub-section pub-second-look-body">
          <p className="pub-lead">
            Before you buy. Before you follow. Before you sign.
          </p>
          <p className="pub-section-intro">
            Second Look is the planned AI second opinion for Solana social
            traders. It turns on-chain observations into understandable research
            and follows the decision through to records, reminders and optional
            wallet controls.
          </p>
          <SecondLookExplorer />
        </div>
      </section>
      <section className="pub-section pub-evidence" id="evidence">
        <Heading
          number="04"
          label="HOW SECOND LOOK THINKS"
          title={
            <>
              Start with facts.
              <br />
              <em>Make them useful.</em>
            </>
          }
        >
          The evidence comes first. AI helps make it understandable.
        </Heading>
        <div className="pub-evidence-flow">
          <div>
            <span className="pub-flow-number">01</span>
            <h3>Observe</h3>
            <p>
              Public-chain activity, token controls, wallet histories and source
              material.
            </p>
          </div>
          <ArrowRight aria-hidden="true" />
          <div>
            <span className="pub-flow-number">02</span>
            <h3>Examine</h3>
            <p>
              Defined checks, simulations, consistent methods and visible
              timestamps.
            </p>
          </div>
          <ArrowRight aria-hidden="true" />
          <div>
            <span className="pub-flow-number">03</span>
            <h3>Explain</h3>
            <p>
              A plain-language card, with reasons and sources you can inspect.
            </p>
          </div>
        </div>
        <div className="pub-evidence-bottom">
          <p>
            Token findings are designed to follow recorded checks. The model
            explains those findings; it does not choose the verdict. Deeper
            reviews add early-trading context and Concur checks on public
            claims.
          </p>
          <p>
            Cards will distinguish what was observed, what is inferred and what
            remains unchecked. Historical evaluation and visible sample sizes
            give the findings context.
          </p>
        </div>
      </section>
      <section className="pub-guard-spread" id="guarded">
        <div className="pub-guard-art">
          <span className="pub-micro">THE GUARDED WALLET / PLANNED</span>
          <Art name="gauntlet" />
          <Ornament />
          <span className="pub-guard-caption">
            PERSONAL RULES. BUILT INTO THE WALLET.
          </span>
        </div>
        <div className="pub-guard-copy" data-pub-reveal>
          <span className="pub-micro">05 / CONTROL BY CHOICE</span>
          <h2>
            Your wallet.
            <br />
            <em>Your rules.</em>
          </h2>
          <p className="pub-lead">
            Choose the boundaries while you have the time to think.
          </p>
          <p>
            The optional Guarded Wallet is designed to enforce daily spend,
            per-token exposure, cool-downs and gross realised-loss limits
            on-chain. Tightening a limit takes effect immediately; loosening it
            includes a waiting period.
          </p>
          <div className="pub-rule-pair">
            <div>
              <strong>Watch mode</strong>
              <p>
                Research and reminders for wallets you link. You act in your
                existing wallet.
              </p>
            </div>
            <div>
              <strong>Guarded mode</strong>
              <p>
                Rules apply to trades inside the Guarded Wallet, with optional
                Exit Plan execution.
              </p>
            </div>
          </div>
          <p className="pub-small">
            The design preserves a home-wallet withdrawal path and keeps sells
            outside the buy limits. Market liquidity and token rules still
            affect execution. Strict mode adds open-position checks through an
            additional service. A staged beta and independent review are part of
            the release plan.
          </p>
        </div>
      </section>
      <section className="pub-section" id="together">
        <Heading
          number="06"
          label="PEOPLE, AGENTS & EVERYDAY ACCESS"
          title={
            <>
              A Conclave
              <br />
              <em>of your own.</em>
            </>
          }
        >
          The same platform, built to meet different ways of working.
        </Heading>
        <div className="pub-community">
          <OrnateFrame className="pub-community-card">
            <span className="pub-micro">FOR TEAMS</span>
            <h3>Chapters.</h3>
            <p>
              Shared projects, defined roles and member allowances. A common
              workspace for a team’s conversations, creative work and decisions.
            </p>
            <Art name="scroll" />
          </OrnateFrame>
          <OrnateFrame className="pub-community-card">
            <span className="pub-micro">FOR TRADING GROUPS</span>
            <h3>Rooms.</h3>
            <p>
              Shared research cards and timestamped calls, with outcomes and
              caller context recorded against chain activity.
            </p>
            <Art name="shield" />
          </OrnateFrame>
        </div>
        <div className="pub-surface-strip">
          <span>WEB</span>
          <i>✳</i>
          <span>TELEGRAM</span>
          <i>✳</i>
          <span>SEEKER / ANDROID</span>
          <i>✳</i>
          <span>iOS</span>
          <i>✳</i>
          <span>API + MCP</span>
        </div>
        <p className="pub-section-intro">
          Mobile share flows bring a link straight into a check. Telegram
          carries cards and alerts into the conversation. API and MCP access let
          authorised agents use the same research tools. Read-only support for
          more chains extends the picture over time.
        </p>
      </section>
      <section className="pub-section pub-principles" id="principles">
        <Heading
          number="07"
          label="THE FOUNDATION"
          title={
            <>
              Clear terms.
              <br />
              <em>Lasting trust.</em>
            </>
          }
        >
          One account, understandable usage and meaningful control.
        </Heading>
        <div className="pub-principle-rows">
          <div id="billing">
            <span>01</span>
            <div>
              <h3>Dynamic usage. One Common Purse.</h3>
              <p>
                Model pricing follows the model and the work requested. The
                current text workflow shows a quote before a paid request and the
                settled cost afterwards. Fund the Common Purse with native USDC
                on Solana mainnet; credit follows finalized verification.
                New services will show their applicable pricing before use.
              </p>
            </div>
            <Art name="coins" />
          </div>
          <div id="identity">
            <span>02</span>
            <div>
              <h3>Access on your terms.</h3>
              <p>
                Sign in with a supported Solana wallet using an ownership
                message. Funding requires a separate approved transaction.
                Second Look’s planned research tools will start with public
                addresses; no seed phrase or private key is needed.
              </p>
            </div>
            <Art name="key" />
          </div>
          <div id="routes">
            <span>03</span>
            <div>
              <h3>Know what leaves the room.</h3>
              <p>
                Hosted model requests pass through an inference gateway and the
                selected model’s host, which process the submitted content.
                Retention and training policies vary by service. Conclave’s
                direction is to make these conditions clear before sending.
              </p>
            </div>
            <Art name="shield" />
          </div>
          <div id="guards">
            <span>04</span>
            <div>
              <h3>A considered step before sending.</h3>
              <p>
                Key Guard is designed to recognise sensitive key material before
                it reaches a model. Explainer and Signature Firewall make
                supported signing requests easier to inspect. Each tool should
                communicate the scope of its checks clearly.
              </p>
            </div>
            <Art name="gauntlet" />
          </div>
        </div>
        <p className="pub-editorial-note">
          Second Look provides research and decision support. Token checks and
          trading limits cannot guarantee an outcome; tax exports provide
          records for review. The user remains the decision-maker.
        </p>
      </section>
      <section className="pub-section pub-next">
        <Ornament />
        <div>
          <span className="pub-micro">08 / FROM VISION TO RELEASES</span>
          <h2>
            The plan has
            <br />
            <em>many chapters.</em>
          </h2>
          <p>
            Live text requests with Claude, GPT, Gemini, Grok, DeepSeek, Qwen and Llama, project tools
            and Solana USDC top-ups are available today. Studio, Second Look,
            receipts and the wider roadmap remain separate future releases.
          </p>
        </div>
        <Link href="/roadmap" className="pub-button">
          SEE THE FULL ROADMAP
          <ArrowUpRight size={18} />
        </Link>
      </section>
    </Publication>
  );
}

export function Roadmap() {
  return (
    <Publication kind="Roadmap">
      <div className="pub-preview-ribbon">
        <span className="pub-status pub-status--preview">Explore now</span>
        <p>
          Available now: Claude, GPT, Gemini, Grok, DeepSeek, Qwen and Llama, project tools,
          and Common Purse top-ups with Solana mainnet USDC.
        </p>
        <Link href="/dashboard">
          OPEN CONCLAVE
          <ArrowUpRight size={14} />
        </Link>
      </div>
      <section className="pub-section pub-map-intro" id="release-map">
        <Heading
          number="THE PLAN"
          label="THREE CONNECTED TRACKS"
          title={
            <>
              A bigger vision.
              <br />
              <em>A deliberate build.</em>
            </>
          }
        >
          The AI workspace. Second Look. Access everywhere. Explore the tracks,
          then open a feature for the detail.
        </Heading>
        <div className="pub-track-overview">
          <a href="#foundation">
            <span className="pub-micro">I / WORKSPACE</span>
            <strong>Think & create.</strong>
            <span>Models, Canvas, Studio, Briefs, agents and Chapters.</span>
            <ArrowDown size={18} />
          </a>
          <a href="#second-look-1">
            <span className="pub-micro">II / SECOND LOOK</span>
            <strong>Research & decide.</strong>
            <span>
              Four phases, from token checks to wallet controls and wider
              coverage.
            </span>
            <ArrowDown size={18} />
          </a>
          <a href="#access">
            <span className="pub-micro">III / ACCESS</span>
            <strong>Take it with you.</strong>
            <span>Telegram, mobile and tools for authorised agents.</span>
            <ArrowDown size={18} />
          </a>
        </div>
        <p className="pub-map-note">
          Chapters describe the release direction, not fixed calendar dates.
          Workspace and access work can progress alongside Second Look’s four
          phases.
        </p>
        <RoadmapExplorer />
      </section>
      <section
        className="pub-release-principles pub-section"
        id="release-principles"
      >
        <Heading
          number="THE APPROACH"
          label="BUILT TO EARN TRUST"
          title={
            <>
              Ambitious by design.
              <br />
              <em>Deliberate in release.</em>
            </>
          }
        >
          A wider product deserves a clear path into people’s hands.
        </Heading>
        <div className="pub-editorial-pair">
          <div>
            <h3>Evidence before a verdict.</h3>
            <p>
              Check coverage, simulations, historical evaluation and wallet
              reconciliation support Second Look’s release quality. Published
              findings should make their evidence and scope easy to inspect.
            </p>
          </div>
          <div>
            <h3>Control before scale.</h3>
            <p>
              Wallet controls progress through a staged beta, independent review
              and tested withdrawal paths. New chains and surfaces follow
              validated coverage and real user needs.
            </p>
          </div>
        </div>
        <Link href="/whitepaper" className="pub-button">
          READ THE FULL VISION
          <ArrowUpRight size={18} />
        </Link>
      </section>
    </Publication>
  );
}
