'use client';

import { useState } from 'react';

/** Copy exactly one displayed snippet. Model-provided code is never executed. */
export function CodeClip({ code, language }: { code: string; language: string }) {
  const [status, setStatus] = useState('');
  const label = /^[\w#+.-]{1,32}$/.test(language) ? language : 'Code';
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setStatus('Code copied.');
    } catch {
      setStatus('Clipboard unavailable. Select the code to copy it.');
    }
  }
  return (
    <div className="cw-code-clip">
      <div className="cw-code-clip-bar">
        <span>{label}</span>
        <button type="button" onClick={() => void copy()} aria-label={`Copy ${label} code`}>Copy code</button>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A wide code snippet needs keyboard scrolling. */}
      <pre tabIndex={0}><code>{code}</code></pre>
      {status && <output className="cw-code-clip-status">{status}</output>}
    </div>
  );
}
