'use client';

import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { describeError } from '@/lib/anonymo/client';
import { CopyButton } from '../copy-button';
import { useAnonymo } from '../anonymo-provider';

export function TelegramLink() {
  const { client, demo } = useAnonymo();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError('');
    setCode('');
    try {
      const next = demo ? `tgl_${crypto.randomUUID().replaceAll('-', '')}` : (await client.telegramLinkCode()).code;
      setCode(next);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Link Telegram</h2>
      <p className="lede">Link your key to add credit with Stars. Anyone who controls the linked Telegram account can open a one-hour workspace chat session that spends this key’s credit.</p>
      <div className="row">
        <button className="btn" type="button" disabled={busy} onClick={() => void generate()}>
          <Link2 size={16} aria-hidden="true" />{busy ? 'Generating…' : 'Generate link code'}
        </button>
      </div>
      {code && (
        <>
          <p className="faint">Paste this code into a private chat with the Anonymo bot within five minutes.</p>
          <div className="row"><code className="mono">{code}</code><CopyButton text={code} label="Copy link code" /></div>
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
  );
}
