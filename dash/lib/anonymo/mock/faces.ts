import { LOOK_INSTRUCTION, SCENE_INSTRUCTION, SHEET_MARK, type Expression } from '../faces.ts';
import { demoImage } from './images.ts';

import { BASE_PLUSH } from '../plush.ts';
import { plushCanvas } from '../plush-image.ts';

export const DEMO_LOOK =
  'An adult felt ship captain with a plum sleep mask, gold stitched eyes and a teal sailor coat with brass buttons.';
export const DEMO_SCENE = 'The lamplit cabin of a small cargo ship at night, charts spread on a wooden table, rain on the round window and the harbour lights blurred beyond it.';

const DEMO_TAG = '(Demo reply: no model ran.)';
const LINES: Record<Expression, string> = {
  happy: '*I laugh, and the grin stays.* "Ha! That is the best thing I have heard all week. Go on, then."',
  surprised: '*I blink, startled.* "Wait. You did that on your own?! I did not see that coming."',
  tender: '*I soften, and say it gently.* "Stay close tonight. I want you here."',
  sad: '*I sigh and look away, toward the dark water.* "I am sorry. There were more goodbyes than I can count."',
  angry: '*I glare, jaw set.* "How dare they. Nobody cheats my crew and walks away from it."',
  calm: '*I set the chart down and study you for a moment.* "Fair enough. We keep to the plan."',
};
/** With nothing in the message to go on, the moods come round in this order, so a short demo shows every face. */
const ROUND: Expression[] = ['happy', 'surprised', 'tender', 'sad', 'angry', 'calm'];
const CUES: [RegExp, Expression][] = [
  [/\b(?:joke|funny|laugh|good news|we did it|celebrate)\b/i, 'happy'],
  [/\b(?:guess what|surprise|secret|suddenly|believe it)\b/i, 'surprised'],
  [/\b(?:thank|love|care|hug|hold|stay with)\b/i, 'tender'],
  [/\b(?:sorry|sad|lost|goodbye|died|alone|bad news)\b/i, 'sad'],
  [/\b(?:angry|betray\w*|cheat\w*|lied|liar|stole)\b/i, 'angry'],
  [/\b(?:plan|calm|steady|report)\b/i, 'calm'],
];

/** The mood a demo character answers in: a cue in the message, else the next one in the round. */
export function demoMood(lastUser: string, turn: number): Expression {
  for (const [cue, mood] of CUES) if (cue.test(lastUser)) return mood;
  return ROUND[((turn % ROUND.length) + ROUND.length) % ROUND.length];
}
export const demoCharacterLine = (mood: Expression) => `${LINES[mood]} ${DEMO_TAG}`;

type Message = { role: string; content?: unknown };
const textOf = (m: Message | undefined) => (typeof m?.content === 'string' ? m.content : '');

/**
 * What the demo gateway says for the requests this update makes, or null for any other chat: a look sentence, a scene
 * sentence, or (when the chat starts with a character's system message) an in-character line.
 */
export function demoFaceReply(messages: Message[]): string | null {
  const users = messages.filter((m) => m.role === 'user');
  const last = textOf(users.at(-1));
  if (last.endsWith(LOOK_INSTRUCTION)) return DEMO_LOOK;
  if (last.endsWith(SCENE_INSTRUCTION)) return DEMO_SCENE;
  if (messages[0]?.role === 'system' && users.length) return demoCharacterLine(demoMood(last, users.length - 1));
  return null;
}

/** The demo uses a local example sheet. Live painting uses the selected model. */
export async function demoPicture(prompt: string, width: number, height: number, index = 0, model = ''): Promise<string> {
  if (!prompt.startsWith(SHEET_MARK) || typeof document === 'undefined') return demoImage(prompt, width, height, index, model);
  const atlas = await plushCanvas(BASE_PLUSH);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not open a canvas.');
  ctx.drawImage(atlas, 0, 0, width, height);
  return canvas.toDataURL('image/png').split(',')[1];
}
