'use client';

import { type CSSProperties, type ReactNode } from 'react';
import { useDeviceSetting } from './use-device-setting';
import '@/app/dashboard/reading-room.css';

type ReadingPreferences = { size: 'small' | 'standard' | 'large'; spacing: 'standard' | 'relaxed' };
const defaults: ReadingPreferences = { size: 'standard', spacing: 'standard' };
function valid(value: unknown): value is ReadingPreferences {
  if (!value || typeof value !== 'object') return false;
  const item = value as ReadingPreferences;
  return ['small', 'standard', 'large'].includes(item.size) && ['standard', 'relaxed'].includes(item.spacing);
}

export function ReadingRoom({ scope, enabled, children }: { scope: string; enabled: boolean; children: ReactNode }) {
  const setting = useDeviceSetting(`conclave-reading-room-v1:${scope}`, defaults, valid, enabled);
  if (!enabled) return children;
  const style = {
    '--cw-reading-font': { small: '15px', standard: '18px', large: '21px' }[setting.value.size],
    '--cw-reading-line': setting.value.spacing === 'relaxed' ? '1.95' : '1.65',
    '--cw-reading-gap': setting.value.spacing === 'relaxed' ? '1.4em' : '1em',
  } as CSSProperties;
  return <div className="cw-reading-surface" data-reading-size={setting.value.size} style={style}>
    <details className="cw-reading-controls">
      <summary>Reading settings</summary>
      <div>
        <label>Text size<select value={setting.value.size} onChange={event => setting.save({ ...setting.value, size: event.target.value as ReadingPreferences['size'] })}>
          <option value="small">Small</option><option value="standard">Standard</option><option value="large">Large</option>
        </select></label>
        <label>Spacing<select value={setting.value.spacing} onChange={event => setting.save({ ...setting.value, spacing: event.target.value as ReadingPreferences['spacing'] })}>
          <option value="standard">Standard</option><option value="relaxed">Relaxed</option>
        </select></label>
        <button type="button" onClick={() => setting.save(defaults)}>Reset</button>
      </div>
      {setting.error && <output>{setting.error}</output>}
    </details>
    {children}
  </div>;
}
