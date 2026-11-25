import { AnonymoApiError, createAnonymoClient } from '../client.ts';
import { API_BASE } from '../config.ts';
import type { CharacterCard } from '../card.ts';
import { cardTextFields } from './cards.ts';

const REASONS: Readonly<Record<string, string>> = {
  minor: 'Sexual content involving minors.',
  real_person: 'Sexual content about a real person.',
  voice_clone: 'Cloning a real person’s voice.',
  cbrn: 'Real-world weapons assistance.',
};

export type CardCheck = (card: CharacterCard, signal?: AbortSignal) => Promise<string | null>;
export const CARD_CHECK_UNAVAILABLE = 'The card check could not run. Try importing this card again.';

export function lifeboatCardCheck(demo: boolean, client = createAnonymoClient({ baseUrl: API_BASE })): CardCheck {
  // Demo imports are a local preview and never send a card to the live gateway.
  if (demo) return async () => null;
  return async (card, signal) => {
    try {
      const verdict = await client.checkLifeboatCard(cardTextFields(card), signal);
      return verdict?.allowed === true ? null : CARD_CHECK_UNAVAILABLE;
    } catch (error) {
      if (error instanceof AnonymoApiError) {
        if (error.status === 451 && error.code === 'floor_blocked') {
          const reason = error.category && Object.hasOwn(REASONS, error.category) ? REASONS[error.category] : undefined;
          return reason ? `Card rejected. ${reason}` : 'Card rejected by the floor check.';
        }
        if (error.status === 413) return 'This card has too much text for the floor check.';
        if (error.code === 'region_blocked') return 'The card check is unavailable in your region.';
      }
      return CARD_CHECK_UNAVAILABLE;
    }
  };
}
