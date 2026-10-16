'use client';
import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { FomoPanel } from './fomo-panel';
import { PerpPanel } from './perp-panel';
import { StockTokenPanel } from './stock-token-panel';
import { secondLookToolOn, type SecondLookTool } from '../../lib/second-look/releases';
import type { PanelProps } from './shared';
import '@/app/dashboard/second-look.css';
import './second-look-tools.css';
export type { ComposerControl, ComposerState } from './shared';

const TOOLS = [
  { id: 'fomo', label: 'FOMO top ten', Panel: FomoPanel },
  { id: 'stockToken', label: 'Stock tokens', Panel: StockTokenPanel },
  { id: 'perp', label: 'Perp Check', Panel: PerpPanel },
] as const satisfies readonly { id: SecondLookTool; label: string; Panel: (props: PanelProps) => React.ReactNode }[];

/** Only explicitly released tools are mounted. With one released tool, no switcher is shown. */
export function SecondLookWorkspace(props: PanelProps) {
  const t = useT();
  const tools = TOOLS.filter((tool) => secondLookToolOn(tool.id));
  const [chosen, setChosen] = useState<SecondLookTool | null>(null);
  const active = tools.find((tool) => tool.id === chosen) ?? tools[0];
  if (!active) return null;
  const { Panel } = active;
  return (
    <>
      {tools.length > 1 && (
        <nav className="sl-tools" aria-label={t('Second Look tools')}>
          {tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              aria-pressed={tool.id === active.id}
              onClick={() => setChosen(tool.id)}
            >
              {t(tool.label)}
            </button>
          ))}
        </nav>
      )}
      <Panel key={`${active.id}:${props.accountId ?? 'signed-out'}`} {...props} />
    </>
  );
}
