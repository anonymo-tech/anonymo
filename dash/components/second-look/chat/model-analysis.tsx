"use client";
import { useState } from "react";
import { ArrowUpRight, Check, Search, Layers, SlidersHorizontal } from "lucide-react";
import { ProviderIcon } from "../../dashboard/answer-card";
import type { AnalysisHost } from "../shared";

export type AnalysisSubject = {
  title: string;
  evidence: string;
  example: boolean;
  id: string;
};
export function ModelAnalysis({
  subject,
  accountId,
  host,
  onSignIn,
  onToast,
  onOpenReview,
}: {
  subject: AnalysisSubject;
  accountId: string | null;
  host: AnalysisHost | undefined;
  onSignIn: () => void;
  onToast: (value: string) => void;
  onOpenReview?: () => void;
}) {
  const models = host?.models ?? [];
  const [chosen, setChosen] = useState<string[]>(() =>
    [...new Set([...(host?.defaultModelIds ?? []), ...models.map((m) => m.id)])].slice(0, 4),
  );
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const ids = chosen.filter((id) => models.some((m) => m.id === id));
  const results = models.filter((m) =>
    (m.name + " " + m.family).toLowerCase().includes(query.toLowerCase()),
  );
  async function analyze() {
    if (!accountId) {
      onSignIn();
      return;
    }
    if (subject.example) {
      onToast("This is a layout example. Paste a real link to run an analysis.");
      return;
    }
    if (!host?.available || ids.length !== 4 || busy) return;
    setBusy(true);
    try {
      await host.analyze({
        title: subject.title,
        prompt: subject.evidence,
        modelIds: ids,
        subjectId: subject.id,
      });
    } catch {
      onToast("The model review could not be prepared. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="fomo-models" aria-label="Research models">
      <div className="fomo-model-heading">
        <span>
          <Layers size={20} aria-hidden="true" />
          Your models
        </span>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={"fomo-model-list-" + subject.id}
        >
          <SlidersHorizontal size={13} aria-hidden="true" /> {ids.length}/4 · Change
        </button>
      </div>
      <div className="fomo-selected">
        {ids.map((id) => (
          <span key={id}>
            <span className="fomo-provider-well">
              <ProviderIcon id={id} size={28} />
            </span>
            <span>{models.find((m) => m.id === id)?.name}</span>
            <Check size={14} className="fomo-selected-check" aria-label="Selected" />
          </span>
        ))}
      </div>
      {open && (
        <div id={"fomo-model-list-" + subject.id} className="fomo-picker">
          <label className="fomo-search">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a model"
              aria-label="Search research models"
            />
          </label>
          <div className="fomo-model-options">
            {results.map((m) => (
              <button
                type="button"
                key={m.id}
                aria-pressed={ids.includes(m.id)}
                disabled={!ids.includes(m.id) && ids.length === 4}
                onClick={() =>
                  setChosen((prev) =>
                    prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...ids, m.id],
                  )
                }
              >
                <ProviderIcon id={m.id} size={21} />
                <span>
                  {m.name}
                  <small>{m.family}</small>
                </span>
                {ids.includes(m.id) && <Check size={15} />}
              </button>
            ))}
          </div>
          {!results.length && <p>No matching models.</p>}
          <small>Deselect a model to choose a replacement.</small>
        </div>
      )}
      <button
        type="button"
        className="fomo-primary"
        disabled={
          !onOpenReview &&
          (busy || (!!accountId && (!host?.available || ids.length !== 4 || subject.example)))
        }
        onClick={onOpenReview ?? (() => void analyze())}
      >
        {onOpenReview
          ? "Open four AI chats"
          : busy
            ? "Preparing review…"
            : accountId
              ? "Review cost & analyze"
              : "Sign in to analyze"}
        <ArrowUpRight size={17} />
      </button>
      {onOpenReview && (
        <button
          type="button"
          className="fomo-review-open"
          disabled={
            busy || (!!accountId && (!host?.available || ids.length !== 4 || subject.example))
          }
          onClick={() => void analyze()}
        >
          Run a new analysis <ArrowUpRight size={13} />
        </button>
      )}
      <small>
        Each model gets the same evidence. Review the actual usage quote before sending.
      </small>
      {accountId && !host?.available && (
        <p role="status">Model analysis is unavailable for this account right now.</p>
      )}
    </section>
  );
}
