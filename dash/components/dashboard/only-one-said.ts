import type { Answer, Turn } from './canvas-state.ts';

/** Exclude status messages and partial output; keep the original blind positions. */
export function onlyOneSaidAnswers(turn: Turn) {
  return turn.answers.flatMap((answer, index) => {
    if (
      answer.live &&
      (answer.live.state !== 'succeeded' || answer.live.outputTruncated)
    )
      return [];
    if (!answer.live && answer.heading === 'No live model result.') return [];
    const text = answer.live
      ? (answer.live.output ?? answer.paragraphs.join('\n\n'))
      : [answer.heading, ...answer.paragraphs].filter(Boolean).join('\n\n');
    return text.trim() ? [{ answer, index, text }] : [];
  });
}

export function buildOnlyOneSaidDraft({
  turn,
  draft,
  instruction,
  modelName,
  answerLabel,
  focusedAnswerId,
  maxCharacters,
  maxBytes,
}: {
  turn: Turn;
  draft: string;
  instruction: string;
  modelName: (answer: Answer) => string;
  answerLabel: (letter: string) => string;
  focusedAnswerId?: string;
  maxCharacters: number;
  maxBytes: number;
}) {
  const answers = onlyOneSaidAnswers(turn);
  if (answers.length < 2) return { status: 'unavailable', draft } as const;
  const blind = Boolean(
    (turn.live?.blind && !turn.live.revealedAt) ||
    turn.answers.some((answer) => answer.modelId === 'blind'),
  );
  const sections = answers.map(({ answer, index, text }) => {
    const letter =
      answer.live?.label?.match(/^Model ([A-D])$/)?.[1] ??
      String.fromCharCode(65 + index);
    const label = blind ? answerLabel(letter) : modelName(answer);
    return `${label}:\n${text}`;
  });
  const addition = [instruction, ...sections].join('\n\n');
  // A second click on the same comparison keeps the draft that is already there.
  const nextDraft = draft.includes(addition)
    ? draft
    : draft
      ? `${draft}\n\n${addition}`
      : addition;
  if (
    nextDraft.length > maxCharacters ||
    new TextEncoder().encode(nextDraft).byteLength > maxBytes
  )
    return { status: 'too-long', draft } as const;
  const focused =
    answers.find(({ answer }) => answer.id === focusedAnswerId) ?? answers[0];
  // Unrevealed model identities must never be used to select the sending model.
  return {
    status: 'ready',
    draft: nextDraft,
    modelId: blind ? null : focused.answer.modelId,
  } as const;
}
