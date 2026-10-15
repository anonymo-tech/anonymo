'use client';

import { useT } from '@/lib/i18n';
import { useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { fomoPromptPresentation } from '../../lib/second-look/fomo-presentation';
import { AnswerCard, ProviderIcon, type AnswerActions } from './answer-card';
import type { Turn } from './canvas-state';
import { MODELS } from './data';
import '../../app/dashboard/chat-thread.css';

export type ChatTurnPreference = {
  activeAnswerId: string;
  comparing: boolean;
};

type ChatThreadProps = {
  turns: Turn[];
  actions: AnswerActions;
  preferences: Record<string, ChatTurnPreference>;
  onPreferenceChange: (turnId: string, preference: ChatTurnPreference) => void;
};

type ChatTurnProps = {
  turn: Turn;
  actions: AnswerActions;
  preference?: ChatTurnPreference;
  onPreferenceChange: ChatThreadProps['onPreferenceChange'];
};

function modelName(modelId: string) {
  return MODELS.find((model) => model.id === modelId)?.name || 'Model';
}

function revealTab(tab: HTMLButtonElement | null | undefined) {
  const list = tab?.parentElement;
  if (!tab || !list) return;
  const tabBounds = tab.getBoundingClientRect();
  const listBounds = list.getBoundingClientRect();
  if (tabBounds.left < listBounds.left) {
    list.scrollLeft -= listBounds.left - tabBounds.left;
  } else if (tabBounds.right > listBounds.right) {
    list.scrollLeft += tabBounds.right - listBounds.right;
  }
}

export function ChatTurn({
  turn,
  actions,
  preference,
  onPreferenceChange,
}: ChatTurnProps) {
  const t = useT();
  const id = useId();
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeAnswer =
    turn.answers.find((answer) => answer.id === preference?.activeAnswerId) ||
    turn.answers[0];
  const activeAnswerId = activeAnswer?.id || '';
  const comparing = Boolean(preference?.comparing && turn.answers.length > 1);
  const questionId = `${id}-question`;
  const researchPrompt = useMemo(() => fomoPromptPresentation(turn.prompt), [turn.prompt]);
  const active = turn.answers.filter(
    (answer) =>
      answer.live?.state === 'queued' || answer.live?.state === 'running',
  );
  // A stop applies to the whole request; once accepted, calls drain for exact billing.
  const running = active.find((answer) => !answer.live?.cancelRequested);
  const stopping = active.length > 0 && !running;
  const several = turn.answers.length > 1;

  useLayoutEffect(() => {
    revealTab(tabs.current[activeAnswerId]);
  }, [activeAnswerId]);

  function focusAnswer(answerId: string) {
    onPreferenceChange(turn.id, {
      activeAnswerId: answerId,
      comparing: false,
    });
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % turn.answers.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + turn.answers.length) % turn.answers.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = turn.answers.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const answerId = turn.answers[nextIndex].id;
    focusAnswer(answerId);
    const tab = tabs.current[answerId];
    tab?.focus({ preventScroll: true });
    revealTab(tab);
  }

  return (
    <section
      className="cw-chat-turn"
      data-chat-turn-id={turn.id}
      aria-labelledby={questionId}
    >
      <p className="cw-chat-prompt" id={questionId}>
        <span className="cw-chat-sr-only">{t('You: ')}</span>
        {researchPrompt?.title ?? t(turn.prompt)}
      </p>
      {researchPrompt && (
        <details className="cw-chat-source-prompt">
          <summary>View source prompt</summary>
          <pre>{researchPrompt.sourcePrompt}</pre>
        </details>
      )}
      {activeAnswer && (
        <>
          <div className="cw-chat-response-bar">
            <div
              className="cw-chat-model-tabs"
              role="tablist"
              aria-label={
                comparing
                  ? t(
                      'Model responses, comparing all. Choose a model to focus.',
                    )
                  : t('Model responses')
              }
              aria-orientation="horizontal"
            >
              {turn.answers.map((answer, index) => {
                const name = t(
                  answer.live?.modelName ||
                    answer.live?.label ||
                    modelName(answer.modelId),
                );
                const selected = actions.selected.includes(answer.id);
                const active = answer.id === activeAnswerId;
                return (
                  <button
                    key={answer.id}
                    ref={(element) => {
                      if (element) tabs.current[answer.id] = element;
                      else delete tabs.current[answer.id];
                    }}
                    type="button"
                    className={`cw-chat-model-tab${active ? ' is-active' : ''}`}
                    id={`${id}-tab-${index}`}
                    role="tab"
                    aria-selected={active}
                    aria-controls={`${id}-panel-${index}`}
                    aria-label={
                      selected
                        ? t('{name}, selected for Brief', { name })
                        : name
                    }
                    tabIndex={active ? 0 : -1}
                    onClick={() => focusAnswer(answer.id)}
                    onKeyDown={(event) => moveTab(event, index)}
                  >
                    <ProviderIcon id={answer.modelId} size={20} />
                    <span>{name}</span>
                    {selected && (
                      <span
                        className="cw-chat-tab-selected"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
            {running && actions.onCancel && (
              <button
                className="cw-chat-compare cw-chat-stop"
                type="button"
                aria-label={
                  several
                    ? t('Stop all {count} model responses', {
                        count: turn.answers.length,
                      })
                    : t('Stop the {name} response', {
                        name: t(
                          running.live?.modelName ||
                            running.live?.label ||
                            modelName(running.modelId),
                        ),
                      })
                }
                onClick={() => actions.onCancel?.(running)}
              >
                <span className="cw-chat-stop-glyph" aria-hidden="true" />
                {several ? t('Stop all') : t('Stop')}
              </button>
            )}
            {stopping && actions.onCancel && (
              <button
                className="cw-chat-compare cw-chat-stop"
                type="button"
                disabled
                title={t(
                  'Measuring usage already dispatched for an exact charge.',
                )}
              >
                <span className="cw-chat-stop-glyph" aria-hidden="true" />
                {t('Stopping…')}
              </button>
            )}
            {turn.answers.length > 1 && (
              <button
                className={`cw-chat-compare${comparing ? ' is-comparing' : ''}`}
                type="button"
                aria-label={
                  comparing
                    ? t('Focus on {name}', {
                        name: t(
                          activeAnswer.live?.modelName ||
                            activeAnswer.live?.label ||
                            modelName(activeAnswer.modelId),
                        ),
                      })
                    : t('Compare all {count} responses', {
                        count: turn.answers.length,
                      })
                }
                aria-controls={`${id}-panels`}
                onClick={() =>
                  onPreferenceChange(turn.id, {
                    activeAnswerId,
                    comparing: !comparing,
                  })
                }
              >
                {comparing ? t('Focus') : t('Compare')}
              </button>
            )}
          </div>
          {comparing && (
            <output className="cw-chat-compare-caption">
              {t('Comparing {count} perspectives', {
                count: turn.answers.length,
              })}
            </output>
          )}
          <div
            className={`cw-chat-panels${comparing ? ' is-comparing' : ''}`}
            id={`${id}-panels`}
          >
            {turn.answers.map((answer, index) => (
              <div
                key={answer.id}
                className="cw-chat-panel"
                id={`${id}-panel-${index}`}
                role="tabpanel"
                aria-labelledby={`${id}-tab-${index}`}
                tabIndex={0}
                hidden={!comparing && answer.id !== activeAnswerId}
              >
                {comparing && (
                  <div className="cw-chat-compare-provider" aria-hidden="true">
                    <ProviderIcon id={answer.modelId} size={18} />
                    <span>
                      {t(
                        answer.live?.modelName ||
                          answer.live?.label ||
                          modelName(answer.modelId),
                      )}
                    </span>
                  </div>
                )}
                <AnswerCard
                  answer={answer}
                  actions={actions}
                  variant="chat"
                  peers={turn.answers.length}
                  researchMarkdown={researchPrompt !== null}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function ChatThread({
  turns,
  actions,
  preferences,
  onPreferenceChange,
}: ChatThreadProps) {
  return (
    <div className="cw-chat-thread">
      {turns.map((turn) => (
        <ChatTurn
          key={turn.id}
          turn={turn}
          actions={actions}
          preference={preferences[turn.id]}
          onPreferenceChange={onPreferenceChange}
        />
      ))}
    </div>
  );
}
