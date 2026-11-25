import type { CardData } from './card.ts';

export const IMAGE_PRESETS = {
  portrait: { label: 'Character portrait', instruction: 'Create a character portrait with an expressive pose, intentional lighting and a simple background.' },
  avatar: { label: 'Avatar', instruction: 'Create a centered head-and-shoulders avatar with a simple background and enough room for a circular crop.' },
  stickers: { label: 'Sticker pack', instruction: 'Create one sticker sheet in a 2×2 grid. Show the same character with four distinct expressions: happy, surprised, annoyed and sleepy. Keep the character design, colors and style consistent. Use white outlines and generous space between stickers.' },
  scene: { label: 'Scene art', instruction: 'Create an illustration with a clear sense of place, lighting and mood. Include the chosen character if supplied.' },
} as const;

export type ImagePreset = keyof typeof IMAGE_PRESETS;
export type StudioPreset = ImagePreset | 'clip';
type StudioCharacter = Pick<CardData, 'name' | 'description' | 'personality' | 'scenario'>;

export function studioPrompt(draft: string, preset: StudioPreset | '', character?: StudioCharacter) {
  const details = draft.trim();
  if (!details && (!character || !preset)) return '';
  const instruction = preset === 'clip'
    ? 'Create a short silent clip with a clear subject, one continuous action and deliberate camera movement.'
    : preset ? IMAGE_PRESETS[preset].instruction : '';
  const context = character ? [
    character.name?.slice(0, 64),
    character.description?.slice(0, 420),
    character.personality?.slice(0, 120),
    preset === 'scene' || preset === 'clip' ? character.scenario?.slice(0, 220) : '',
  ].map((part) => part?.trim()).filter(Boolean).join(' · ') : '';
  return [instruction, context && `Character context: ${context}`, details].filter(Boolean).join('\n\n');
}
