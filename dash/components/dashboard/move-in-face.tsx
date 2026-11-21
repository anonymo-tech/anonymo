import type { CSSProperties } from 'react';
import { Photo } from '@/components/photo';
import { ringOf } from '@/lib/anonymo/movein/cards';

/**
 * The picture beside a character that moved in. An export brings no picture Anonymo shows, so every character wears
 * the mascot, with a stitched ring in a felt colour that comes from its name: the same name, the same colour.
 *
 * FACE SLOT. This is the one place a face goes. When update "faces" is merged, render that character's face here
 * (look it up by `characterId`) and keep the mascot below as the fallback for a character that has none. Characters
 * belong to the mascot's felt-plush world: nothing drawn here should be a generic person.
 */
export function MoveInFace({ name, size = 56 }: { characterId: string; name: string; size?: number }) {
  return (
    <span className="mi-face" style={{ '--mi-ring': ringOf(name), '--mi-face': `${size}px` } as CSSProperties}>
      <Photo src="/mascot/avatar.jpg" alt="" width={size} height={size} />
    </span>
  );
}
