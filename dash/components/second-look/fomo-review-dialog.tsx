"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleHelp,
  Copy,
  Expand,
  FileSearch,
  LoaderCircle,
  X,
} from "lucide-react";
import { ProviderIcon } from "../dashboard/answer-card";
import type { Answer, Turn } from "../dashboard/canvas-state";
import { ResearchMarkdown } from "./chat/research-markdown";
import { FomoEntityImage } from "./fomo-entity-image";
import { fomoAnalysisBody, parseFomoScore } from "../../lib/second-look/fomo-score";
import "./fomo-review-dialog.css";

export function FomoReviewDialog({
  open,
  onClose,
  title,
  avatarUrl,
  turn,
  models,
  onToast,
  subjectKind,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  avatarUrl?: string | null;
  subjectKind: "profile" | "callout";
  turn?: Turn;
  models: readonly { id: string; name: string }[];
  onToast: (text: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current,
      previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    setFocused(null);
  }, [turn?.id]);
  if (!open || typeof document === "undefined") return null;
  const answers = turn?.answers ?? [];
  const complete = answers.filter((a) => a.live?.state === "succeeded").length;
  const pending = answers.some(
    (a) => !["succeeded", "failed", "cancelled", "expired"].includes(a.live?.state ?? ""),
  );
  return createPortal(
    <dialog
      ref={dialog}
      className="fomo-review-dialog"
      aria-labelledby="fomo-review-title"
      onCancel={onClose}
      onClose={onClose}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
          onClose();
      }}
    >
      <header className="fomo-review-header">
        <div className="fomo-review-subject">
          <FomoEntityImage src={avatarUrl} kind="profile" label={`${title} profile photo`} />
          <div>
            <span>Four-model review</span>
            <h2 id="fomo-review-title">{title}</h2>
          </div>
        </div>
        <div className="fomo-review-actions">
          <span role="status">
            {pending ? (
              <LoaderCircle size={14} className="fomo-review-spin" />
            ) : (
              <Check size={14} />
            )}{" "}
            {complete}/{answers.length || 4} complete
          </span>
          <button type="button" aria-label="Close AI review" onClick={onClose}>
            <X size={21} />
          </button>
        </div>
      </header>
      <div className="fomo-review-question">
        <span>
          Audit the {subjectKind === "profile" ? "account" : "callout"}. Verify the evidence behind each finding.
        </span>
        <details className="fomo-score-method">
          <summary>
            <CircleHelp size={14} /> How scores work
          </summary>
          <div>
            <strong>One algorithm. Four evidence audits.</strong>
            <p>
              The research method checks net returns, downside, consistency, execution and callout
              outcomes. Models explain and challenge the evidence; they do not choose the grade.
            </p>
            <p>
              The Research tab separately scores observed public-call outcomes from historical prices.
              Account-wide performance still requires reconciled trading history. Original saved model opinions remain in their full responses.
            </p>
          </div>
        </details>
      </div>
      {focused && (
        <button className="fomo-review-back" onClick={() => setFocused(null)}>
          <ArrowLeft size={15} /> All four models
        </button>
      )}
      <div className={`fomo-review-grid${focused ? " is-focused" : ""}`}>
        {answers.length ? (
          answers
            .filter((a) => !focused || a.id === focused)
            .map((answer) => (
              <ReviewChat
                key={answer.id}
                answer={answer}
                name={
                  answer.live?.modelName ??
                  models.find((m) => m.id === answer.modelId)?.name ??
                  answer.modelId
                }
                focused={focused === answer.id}
                onFocus={() => setFocused(answer.id)}
                onToast={onToast}
                scoreLabel="Evidence review"
              />
            ))
        ) : (
          <p className="fomo-review-empty">
            The four chats will appear after the usage quote is approved. No model request has
            started yet.
          </p>
        )}
      </div>
      {pending && (
        <footer className="fomo-review-footer">
          <span>Closing keeps the analysis running.</span>
        </footer>
      )}
    </dialog>,
    document.body,
  );
}

function ReviewChat({
  answer,
  name,
  focused,
  onFocus,
  onToast,
  scoreLabel,
}: {
  scoreLabel: string;
  answer: Answer;
  name: string;
  focused: boolean;
  onFocus: () => void;
  onToast: (s: string) => void;
}) {
  const [copyState, setCopyState] = useState("Copy response");
  const output = answer.live?.output ?? answer.paragraphs.join("\n\n");
  const done = answer.live?.state === "succeeded";
  const failed = ["failed", "cancelled", "expired"].includes(answer.live?.state ?? "");
  const score = done ? parseFomoScore(output) : null;
  const body = fomoAnalysisBody(output);
  return (
    <article
      className={`fomo-review-chat${focused ? " is-focused" : ""}`}
      aria-label={`${name} analysis`}
    >
      <header>
        <div>
          <span className="fomo-review-provider">
            <ProviderIcon id={answer.modelId} size={25} />
          </span>
          <h3>{name}</h3>
        </div>
        <span className="fomo-review-status" role="status">
          {done ? (
            <>
              <Check size={13} /> Complete
            </>
          ) : failed ? (
            "Stopped"
          ) : (
            <>
              <span className="fomo-thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {output ? "Analyzing" : "Queued"}
            </>
          )}
        </span>
      </header>
      <div className="fomo-review-scroll" tabIndex={0} aria-label={`${name} response`}>
        <section className="fomo-model-score" aria-label={`${name} score`}>
          <div className="fomo-score-number">
            <span><FileSearch size={28}/></span>
            
            <p>{scoreLabel}</p>
          </div>
          <div className="fomo-score-reason">
            <span className="fomo-score-confidence">Model interpretation</span>
            <p>The Research tab holds the computed call score and its reasons. These model responses are separate interpretations of their supplied evidence.</p>
          </div>
        </section>
        {body ? (
          <div className="fomo-review-message">
            {score?.score !== null && score?.score !== undefined && <p className="fomo-archived-opinion">Earlier model opinion. Its original number is not the algorithm score.</p>}
            <ResearchMarkdown text={body} />
          </div>
        ) : (
          <div className="fomo-review-waiting">
            <LoaderCircle size={17} className="fomo-review-spin" />
            <span>
              {failed ? "No response was returned." : "Waiting for this model’s response…"}
            </span>
          </div>
        )}
        {score && (
          <div className="fomo-score-observations">
            {score.strengths.length > 0 && (
              <details>
                <summary>
                  <Check size={13} /> What supports it <small>{score.strengths.length}</small>
                </summary>
                <ul>
                  {score.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </details>
            )}
            {score.risks.length > 0 && (
              <details>
                <summary>
                  <CircleHelp size={13} /> What concerns it <small>{score.risks.length}</small>
                </summary>
                <ul>
                  {score.risks.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </details>
            )}
            {score.missing.length > 0 && (
              <details>
                <summary>
                  <CircleHelp size={13} /> Missing evidence <small>{score.missing.length}</small>
                </summary>
                <ul>
                  {score.missing.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
      <footer>
        <button
          type="button"
          disabled={!output}
          onClick={() =>
            void navigator.clipboard.writeText(output).then(
              () => {
                setCopyState("Copied");
                onToast(`${name} response copied.`);
              },
              () => {
                setCopyState("Copy unavailable");
                onToast("Copy is unavailable. Select the response text to copy it.");
              },
            )
          }
        >
          <Copy size={13} /> {copyState}
        </button>
        {!focused && (
          <button type="button" onClick={onFocus}>
            <Expand size={13} /> Expand
          </button>
        )}
        {focused && (
          <span>
            <ArrowUpRight size={13} /> Full response
          </span>
        )}
      </footer>
    </article>
  );
}
