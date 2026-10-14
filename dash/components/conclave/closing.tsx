"use client";

import { useT } from '@/lib/i18n';
import Link from "@/components/site-link";
import { ArrowUpRight, ArrowUp } from "lucide-react";
import { Flourish, Ornament } from "./ornament";
import { HorseMark } from "./horse-mark";
import { Wordmark } from "./wordmark";
import "./closing.css";

function ClosingSeal({ className = "" }: { className?: string }) {
  return (
    <span className={`cl-closing-seal ${className}`} aria-hidden="true">
      <svg className="cl-seal-orbit" viewBox="0 0 240 240" fill="none">
      <circle
        cx="120"
        cy="120"
        r="108"
        stroke="currentColor"
        strokeWidth=".6"
      />
      <circle
        cx="120"
        cy="120"
        r="100"
        stroke="currentColor"
        strokeWidth=".6"
        strokeDasharray="1 5"
      />
      <g className="cl-seal-turn" stroke="currentColor" strokeWidth=".7">
        {Array.from({ length: 32 }, (_, index) => (
          <path
            key={index}
            d={index % 4 === 0 ? "M120 11v15" : "M120 17v7"}
            transform={`rotate(${index * 11.25} 120 120)`}
          />
        ))}
        <circle cx="120" cy="120" r="89" />
      </g>
      </svg>
      <HorseMark className="cl-footer-horse" />
    </span>
  );
}

function OpenPortal() {
  const t = useT();
  return (
    <div className="cl-open-portal">
      <svg
        className="cl-portal-architecture"
        viewBox="0 0 420 600"
        fill="none"
        aria-hidden="true"
      >
        <g stroke="currentColor" strokeWidth=".75">
          <path d="M28 558V244C28 102 109 25 210 25s182 77 182 219v314M40 558V244C40 110 115 37 210 37s170 73 170 207v314M53 558V246C53 120 122 51 210 51s157 69 157 195v312" />
          <path
            d="M70 558V250C70 135 132 71 210 71s140 64 140 179v308M82 558V250C82 143 139 84 210 84s128 59 128 166v308"
            opacity=".42"
          />
          <path d="M16 559h388M9 568h402M2 578h416M28 548h364M53 540h314" />
          <path d="M210 25V0M0 244h61m298 0h61M18 433h36m312 0h36M197 11h26" />
          <path d="M27 232c-15-30-24-37-13-56 10-16 28-2 18 8-9 7-17-6-11-11m372 59c15-30 24-37 13-56-10-16-28-2-18 8 9 7 17-6 11-11M73 97c-13-12-26-6-23 4 3 10 17 4 12-2m285-2c13-12 26-6 23 4-3 10-17 4-12-2" />
          <path d="M209 83c-23-41-72-29-58-9 8 13 26 2 15-5m45 14c23-41 72-29 58-9-8 13-26 2-15-5M210 51c-12-22-1-32 0-37 1 5 12 15 0 37Z" />
          <path d="M27 434c-17 13-17 31-5 36 13 5 20-12 9-15m362-21c17 13 17 31 5 36-13 5-20-12-9-15" />
          <path d="M210 583v17m-10-8h20M97 578l-14 14m240-14 14 14" />
          <g opacity=".37">
            {Array.from({ length: 18 }, (_, index) => (
              <path key={index} d={`M${82 + index * 15} 543v15`} />
            ))}
          </g>
          <g className="cl-portal-stars">
            <path
              d="m145 157 4 15 15 4-15 4-4 15-4-15-15-4 15-4 4-15Zm138 53 3 10 10 3-10 3-3 10-3-10-10-3 10-3 3-10Z"
              fill="currentColor"
              stroke="none"
            />
            <circle cx="195" cy="126" r="1.5" fill="currentColor" />
            <circle cx="257" cy="170" r="1" fill="currentColor" />
            <circle cx="120" cy="222" r="1" fill="currentColor" />
          </g>
          <path
            className="cl-portal-horizon"
            d="M83 475c51-23 82-23 127-11 45-12 77-12 127 11M84 483c50-15 78-18 126-8 48-10 77-7 126 8M84 493c66-7 88-11 126-6 38-5 60-1 126 6"
            opacity=".35"
          />
        </g>
      </svg>
      <span className="cl-portal-top-note">{t("A DIFFERENT PERSPECTIVE AWAITS")}</span>
      <Link
        href="/dashboard"
        className="cl-portal-entry"
        aria-label={t("Enter Conclave — open the chat")}
      >
        <span className="cl-portal-ring" aria-hidden="true" />
        <span
          className="cl-portal-ring cl-portal-ring-inner"
          aria-hidden="true"
        />
        <span className="cl-portal-entry-kicker">{t("THE DOOR IS OPEN")}</span>
        <span className="cl-portal-entry-title">
          {t.rich("Step{line}{inside}", {
            line: <br />,
            inside: <em>{t("inside.")}</em>,
          })}
        </span>
        <span className="cl-portal-arrow">
          <ArrowUpRight size={29} strokeWidth={1.2} />
        </span>
      </Link>
      <span className="cl-portal-bottom-note">
        {t("ENTER CONCLAVE")} <span>↗</span>
      </span>
      <span className="cl-portal-side-note">{t("MANY MINDS / YOUR JUDGMENT")}</span>
    </div>
  );
}

const footerGroups = [
  {
    number: "I",
    title: "The room",
    links: [
      ["Enter Conclave", "/dashboard"],
      ["Side by Side", "/dashboard#chat"],
      ["Follow-ups", "/dashboard#chat"],
      ["Auto routing", "/dashboard#chat"],
    ],
  },
  {
    number: "II",
    title: "The principles",
    links: [
      ["Where requests go", "/dashboard#chat"],
      ["Sign in with a wallet", "/dashboard#chat"],
      ["Guards, planned", "/docs#guards"],
      ["Clear accounts", "/docs#billing"],
    ],
  },
  {
    number: "III",
    title: "The possibility",
    links: [
      ["Our thinking", "#manifesto"],
      ["Chapters, planned", "/dashboard#chat"],
      ["The road ahead", "#roadmap"],
      ["The field guide", "/docs"],
    ],
  },
];

export function Closing() {
  const t = useT();
  return (
    <div className="conclave-closing">
      <section
        className="cl-invitation"
        id="invitation"
        aria-labelledby="cl-invitation-title"
      >
        <div className="cl-closing-index">
          <span>{t("09 / AN OPEN INVITATION")}</span>
          <span>{t("THE LAST WORD IS YOURS.")}</span>
        </div>
        <div className="cl-invitation-layout">
          <div className="cl-invitation-copy">
            <div className="cl-invitation-marginalia">
              <span>{t("ONE QUESTION CAN CHANGE THE ROOM.")}</span>
              <Ornament />
            </div>
            <h2 id="cl-invitation-title">
              {t.rich("Bring your{line1}{next} {great}{line2}{question}", {
                line1: <br />,
                next: <span>{t("next")}</span>,
                great: <em>{t("great")}</em>,
                line2: <br />,
                question: <em>{t("question.")}</em>,
              })}
            </h2>
            <div className="cl-invitation-note">
              <span className="cl-note-mark" aria-hidden="true">
                ✳
              </span>
              <p>
                {t.rich("Another mind. An unexpected angle.{line}A little more room for possibility.", { line: <br /> })}
              </p>
            </div>
            <Link href="/docs" className="cl-closing-guide">
              {t("GET TO KNOW THE ROOM")} <ArrowUpRight size={16} />
            </Link>
          </div>
          <OpenPortal />
        </div>
        <div className="cl-invitation-baseline">
          <span>{t("FOR PEOPLE WHO REFUSE THE FIRST ANSWER.")}</span>
          <span className="cl-baseline-star" aria-hidden="true">
            ✦
          </span>
          <span>{t("OPEN THE CHAT. SEVEN MODELS, ONE ROOM.")}</span>
        </div>
      </section>

      <footer className="cl-footer" role="contentinfo" aria-label={t("Conclave footer")}>
        <div className="cl-footer-prelude">
          <span>
            {t.rich("INDEPENDENT MINDS. {ground}", { ground: <em>{t("COMMON GROUND.")}</em> })}
          </span>
          <Link href="#top" className="cl-back-top">
            <span>{t("BACK TO THE BEGINNING")}</span>
            <ArrowUp size={19} strokeWidth={1.2} />
          </Link>
        </div>
        <div className="cl-footer-inkband">
          <Flourish className="cl-footer-corner cl-footer-corner-tl" />
          <Flourish className="cl-footer-corner cl-footer-corner-br" />
          <div className="cl-footer-emblem">
            <ClosingSeal />
            <p>
              {t("EVERY MODEL.")}
              <br />
              {t("ONE ROOM.")}
              <br />
              <span>{t("YOUR JUDGMENT.")}</span>
            </p>
            <span className="cl-footer-edition">{t("EST. 2026 / VOL. 001")}</span>
          </div>
          <nav className="cl-footer-navigation" aria-label={t("Explore Conclave")}>
            {footerGroups.map((group) => (
              <div className="cl-footer-navgroup" key={group.number}>
                <span className="cl-footer-nav-index">{group.number} /</span>
                <h3>{t(group.title)}</h3>
                {group.links.map(([label, href]) => (
                  <Link href={href} key={label}>
                    <span>{t(label)}</span>
                    <ArrowUpRight size={14} strokeWidth={1.2} />
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="cl-footer-edition-note">
            <span>{t("A NOTE ON THIS EDITION")}</span>
            <p>
              {t.rich("An early release. Seven live models through one provider.{line}Prepaid credits today; USDC deposits are planned.", { line: <br /> })}
            </p>
            <Ornament />
          </div>
        </div>
        <div className="cl-footer-signature" aria-label="Conclave">
          <span className="cl-signature-small">
            {t("A ROOM FOR EVERY PERSPECTIVE.")}
          </span>
          <div className="cl-footer-wordmark" aria-hidden="true">
            <Wordmark uppercase /><sup>®</sup>
          </div>
          <div className="cl-signature-rule" aria-hidden="true">
            <span />
            <Ornament />
            <span />
          </div>
        </div>
        <div className="cl-footer-colophon">
          <span>© 2026 CONCLAVE</span>
          <span>
            {t.rich("MANY MINDS. {star} ONE COMMON GROUND.", { star: <span aria-hidden="true">✦</span> })}
          </span>
          <span>{t("SOLANA / WORLDWIDE")}</span>
        </div>
      </footer>
    </div>
  );
}
