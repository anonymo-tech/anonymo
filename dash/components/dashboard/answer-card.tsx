'use client';

import type {PaperSource} from '../../lib/paper-trail';
import {PaperSources} from './paper-sources';
import { featureOn } from './feature-switches';
import { ReadToMe } from './read-to-me';
import { QuoteReply } from './quote-reply';
import '@/app/dashboard/everyday-updates.css';
import { useT } from '@/lib/i18n';
import Image from 'next/image';
import { useRef } from 'react';
import { MotionIcon } from './motion-icon';
import { MODELS } from './data';
import { chineseModelByKey } from '../../lib/chinese-models';
import type { Answer } from './canvas-state';
import { formatAccountUsd6 } from '../../lib/client/account-records';
import { CANCEL_DRAIN_TIMEOUT } from '../../lib/client/workspace';
import '../../app/dashboard/answer-card.css';
import { fomoAnalysisBody } from '../../lib/second-look/fomo-score';
import { ResearchMarkdown } from '../second-look/chat/research-markdown';

const providerAssets: Record<string, string> = {
  claude: 'claude',
  gemini: 'gemini',
  gpt: 'openai',
  deepseek: 'deepseek',
  qwen: 'qwen',
  llama: 'meta',
  runway: 'runway',
  veo: 'gemini',
  sora: 'openai',
  kling: 'kling',
};
const chineseProviderAssets: Record<string, string> = {
  deepseek: 'deepseek.svg', qwen: 'qwen.svg', kimi: 'kimi.png', glm: 'glm.svg', minimax: 'minimax.ico', stepfun: 'stepfun.svg', mimo: 'mimo.ico', hunyuan: 'hunyuan.svg', seed: 'seed.ico', ling: 'ling.png', longcat: 'longcat.svg',
};
/** Provider marks; models without a bundled mark use their monogram, never a third-party logo. */
export function ProviderIcon({ id, size = 28 }: { id: string; size?: number }) {
  const chineseProvider = chineseModelByKey.get(id)?.provider;
  const asset = chineseProvider ? chineseProviderAssets[chineseProvider] : providerAssets[id] ? `${providerAssets[id]}.svg` : undefined;
  const monogram = asset
    ? null
    : MODELS.find((model) => model.id === id)?.monogram;
  if (monogram)
    return (
      <span
        aria-hidden="true"
        className="cw-provider-icon cw-provider-monogram"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(9, Math.round(size * 0.56)),
        }}
      >
        {monogram}
      </span>
    );
  if (!asset)
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          display: 'inline-grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        ◇
      </span>
    );
  return (
    <Image
      className="cw-provider-icon"
      src={`/brand/providers/${asset}`}
      style={{ objectFit: 'contain' }}
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  );
}

export type AnswerActions = {
  selected: string[];
  /** Omitted when Brief selection is hidden. */
  onSelect?: (id: string) => void;
  onCopy: (answer: Answer) => void;
  onBranch: (answer: Answer) => void;
  onQuote?: (answer: Answer, text: string) => void;
  /** Omitted when route inspection is hidden. */
  onRoute?: (id: string) => void;
  onCancel?: (answer: Answer) => void;
  onVote?: (answer: Answer) => void;
  onReveal?: (answer: Answer) => void;
  onLoadFull?: (answer: Answer) => void;
};

export function AnswerCard({
  answer,
  actions,
  variant = 'canvas',
  peers,
  researchMarkdown = false,
  paperSource,
}: {
  answer: Answer;
  actions: AnswerActions;
  variant?: 'canvas' | 'chat';
  /** Answers in this turn; a stop applies to every answer still running. */
  peers?: number;
  /** Display-only formatting for detected FOMO research; ordinary answers stay unchanged. */
  researchMarkdown?: boolean;
  paperSource?: PaperSource;
}) {
  const t = useT();
  const model = MODELS.find((item) => item.id === answer.modelId);
  const modelName = t(
    answer.live?.modelName || answer.live?.label || model?.name || 'Model',
  );
  const liveState = answer.live?.state;
  const active = liveState === 'queued' || liveState === 'running';
  const stopping = active && answer.live?.cancelRequested === true;
  const drainTimedOut =
    liveState === 'reconciliation_pending' &&
    answer.live?.errorCode === CANCEL_DRAIN_TIMEOUT;
  const amount = answer.live?.billing.actualUsd6;
  const cost =
    amount !== null && amount !== undefined
      ? `$${formatAccountUsd6(amount)}`
      : null;
  const selected = actions.selected.includes(answer.id);
  const isChat = variant === 'chat';
  const formatted = researchMarkdown || featureOn('cleanRead');
  const menu = useRef<HTMLDetailsElement>(null);
  const menuIconSize = isChat ? 18 : 20;
  const { onSelect, onRoute } = actions;
  const selectControl = onSelect && (
    <button
      data-icon-trigger
      className={`cw-answer-control cw-answer-select${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(answer.id)}
      aria-pressed={selected}
      aria-label={
        selected
          ? t('Deselect {name} answer', { name: modelName })
          : t('Select {name} answer', { name: modelName })
      }
      title={selected ? t('Remove from selection') : t('Select for a Brief')}
    >
      <MotionIcon name="select" size={18} active={selected} />
      {isChat && <span>{selected ? t('Selected') : t('Select')}</span>}
    </button>
  );
  const copyControl = (
    <button
      data-icon-trigger
      className="cw-answer-control"
      onClick={() => actions.onCopy(answer)}
      aria-label={t('Copy {name} answer', { name: modelName })}
      title={t('Copy answer')}
    >
      <MotionIcon name="copy" size={18} />
      {isChat && <span>{t('Copy')}</span>}
    </button>
  );
  function performMenuAction(action: () => void) {
    if (isChat && menu.current) {
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    }
    action();
  }
  return (
    <article
      className={`cw-answer cw-node-drag${selected ? ' is-selected' : ''}${isChat ? ' is-chat-answer' : ''}${formatted ? ' is-fomo-answer' : ''}`}
      aria-label={answer.live ? t('{name} answer', { name: modelName }) : t('{name} sample answer', { name: modelName })}
      aria-busy={active}
    >
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Overflowing answers must be keyboard-scrollable. */}
      <div
        className="cw-answer-body nodrag nowheel"
        data-quote-answer={featureOn('quoteReply') && actions.onQuote ? answer.id : undefined}
        tabIndex={isChat ? undefined : 0}
      >
        {answer.heading && <h2>{t(answer.heading)}</h2>}
        {formatted ? <ResearchMarkdown codeCopy={featureOn('codeClip')} text={researchMarkdown ? fomoAnalysisBody(answer.paragraphs.join('\n\n')) : answer.paragraphs.join('\n\n')} /> : answer.paragraphs.map((paragraph, index) => (
          <p key={index}>
            {answer.live?.output ? paragraph : t(
              answer.heading === 'No live model result.' &&
                paragraph ===
                  'Use a prepared example to explore the comparison, or keep this question in your room for later.'
                ? 'Use a prepared example to explore the comparison, or keep this question in your project for later.'
                : paragraph,
            )}
          </p>
        ))}
        {answer.live?.state === 'succeeded' && answer.live.errorCode === 'OUTPUT_LIMIT_REACHED' && (
          /* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Preserve the production paragraph styling and status announcement. */
          <p role="status">{t('This answer reached the model’s maximum response length. Ask “continue” to pick up where it stopped.')}</p>
        )}
        {answer.live?.outputTruncated && (
          <button
            className="ct-button"
            type="button"
            onClick={() => actions.onLoadFull?.(answer)}
          >
            {t('Load full answer ({count} characters)', {
              count: answer.live.outputLength?.toLocaleString() ?? '',
            })}
          </button>
        )}
      </div>
      {featureOn('quoteReply') && actions.onQuote && <QuoteReply answerId={answer.id} onQuote={text => actions.onQuote?.(answer, text)} />}
      {featureOn('paperTrail') && paperSource && <PaperSources source={paperSource} text={answer.paragraphs.join('\n\n')}/>}
      {featureOn('readToMe') && (!answer.live || (answer.live.state==='succeeded' && !answer.live.outputTruncated)) && <ReadToMe key={answer.id+answer.paragraphs.join('').length} text={answer.paragraphs.join('\n\n')} />}
      <footer className="cw-answer-footer">
        {!isChat && (
          <span className="cw-answer-attribution">
            <ProviderIcon id={answer.modelId} size={18} />
            <span>{modelName}</span>
          </span>
        )}
        <div className="cw-answer-controls nodrag nowheel">
          {isChat ? (
            <>
              {copyControl}
              {selectControl}
            </>
          ) : (
            <>
              {selectControl}
              {copyControl}
            </>
          )}
          {answer.live && (
            <small
              title={
                drainTimedOut
                  ? t(
                      'Stopped. The provider did not confirm usage in time, so the final cost is being reconciled. Reserved funds remain held until then.',
                    )
                  : liveState === 'reconciliation_pending'
                    ? t(
                        'The final cost is being reconciled. Reserved funds remain held.',
                      )
                    : stopping
                      ? t(
                          'Stopping. Usage already dispatched is being measured for an exact charge.',
                        )
                      : undefined
              }
            >
              {answer.live.billing.maximumUsd6 === null
                ? t('Cost after reveal')
                : drainTimedOut
                  ? t('Stopped · Cost pending')
                  : liveState === 'reconciliation_pending'
                    ? t('Cost pending')
                    : liveState === 'succeeded'
                      ? (cost ?? t('Cost pending'))
                      : stopping
                        ? t('Stopping…')
                        : liveState === 'running'
                          ? t('Generating…')
                          : liveState === 'queued'
                            ? t('Queued')
                            : liveState === 'cancelled'
                              ? cost
                                ? t('Stopped · {cost}', { cost })
                                : t('Stopped')
                              : t('Failed')}
            </small>
          )}
          <details ref={menu} className="cw-answer-menu">
            <summary
              data-icon-trigger
              aria-label={t('More actions for {name} answer', {
                name: modelName,
              })}
              title={t('More actions')}
            >
              <MotionIcon name="more" size={18} />
            </summary>
            <div className="cw-menu cw-answer-menu-content">
              {answer.live && active && !stopping && actions.onCancel && (
                <button
                  type="button"
                  onClick={() =>
                    performMenuAction(() => actions.onCancel?.(answer))
                  }
                >
                  {peers === undefined
                    ? t('Stop this request')
                    : peers > 1
                      ? t('Stop all models')
                      : t('Stop')}
                </button>
              )}
              {answer.modelId === 'blind' && actions.onVote && (
                <button
                  type="button"
                  disabled={liveState !== 'succeeded'}
                  onClick={() =>
                    performMenuAction(() => actions.onVote?.(answer))
                  }
                >
                  {t('Prefer this answer & reveal')}
                </button>
              )}
              {answer.modelId === 'blind' && actions.onReveal && (
                <button
                  type="button"
                  onClick={() =>
                    performMenuAction(() => actions.onReveal?.(answer))
                  }
                >
                  {t('Reveal model names')}
                </button>
              )}

              {onSelect && (
                <button
                  data-icon-trigger
                  onClick={() => performMenuAction(() => onSelect(answer.id))}
                  aria-pressed={selected}
                >
                  <MotionIcon
                    name="select"
                    size={menuIconSize}
                    active={selected}
                  />
                  {selected
                    ? t('Remove from selection')
                    : t('Select for a Brief')}
                </button>
              )}
              <button
                data-icon-trigger
                onClick={() => performMenuAction(() => actions.onCopy(answer))}
              >
                <MotionIcon name="copy" size={menuIconSize} />
                {t('Copy answer')}
              </button>
              <button
                data-icon-trigger
                onClick={() =>
                  performMenuAction(() => actions.onBranch(answer))
                }
              >
                <MotionIcon name="branch" size={menuIconSize} />
                {t('Follow up')}
              </button>
              {onRoute && (
                <button
                  data-icon-trigger
                  disabled={answer.modelId === 'blind'}
                  onClick={() =>
                    performMenuAction(() => onRoute(answer.modelId))
                  }
                >
                  <MotionIcon name="route" size={menuIconSize} />
                  {t('Inspect route')}
                </button>
              )}
            </div>
          </details>
        </div>
      </footer>
    </article>
  );
}
