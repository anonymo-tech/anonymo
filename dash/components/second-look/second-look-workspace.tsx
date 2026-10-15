'use client';
import { FomoPanel } from './fomo-panel';
import { secondLookToolOn } from '../../lib/second-look/releases';
import type { PanelProps } from './shared';
import '@/app/dashboard/second-look.css';
export type { ComposerControl, ComposerState } from './shared';
/** Only explicitly released tools are mounted. FOMO does not release the other tools. */
export function SecondLookWorkspace(props: PanelProps) {
  return secondLookToolOn('fomo') ? <FomoPanel key={props.accountId ?? 'signed-out'} {...props} /> : null;
}
