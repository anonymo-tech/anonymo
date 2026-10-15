'use client';
import { useState } from 'react';
import { useDeviceSetting } from './use-device-setting';
import { EverydayDialog } from './everyday-dialog';
import { scanPrompt } from '../../lib/guards';
import {
  isQuickPhrases,
  expandPhrase,
  type QuickPhrase,
} from '../../lib/quick-phrases';
export function QuickPhrases({
  scope,
  draft,
  onChange,
}: {
  scope: string;
  draft: string;
  onChange: (text: string) => void;
}) {
  const saved = useDeviceSetting(
    `conclave-phrases-v1:${scope}`,
    [] as QuickPhrase[],
    isQuickPhrases,
  );
  const [open, setOpen] = useState(false),
    [shortcut, setShortcut] = useState(''),
    [text, setText] = useState(''),
    [error, setError] = useState('');
  const match = saved.value.find((p) => draft.endsWith(`/${p.shortcut}`));
  const insert = (p: QuickPhrase) => {
    onChange(
      match?.shortcut === p.shortcut
        ? expandPhrase(draft, p)
        : [draft, p.text].filter(Boolean).join('\n\n'),
    );
    setOpen(false);
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Quick Phrases
      </button>
      {match && (
        <button type="button" onClick={() => insert(match)}>
          Insert /{match.shortcut}
        </button>
      )}
      {open && (
        <EverydayDialog title="Quick Phrases" onClose={() => setOpen(false)}>
          <p className="eu-note">
            Instructions you reuse, saved on this device. Type a shortcut in
            your message or select it here.
          </p>
          {saved.value.map((p) => (
            <div key={p.shortcut}>
              <button className="eu-result" onClick={() => insert(p)}>
                <strong>/{p.shortcut}</strong>
                <span>{p.text.slice(0, 120)}</span>
              </button>
              <button
                onClick={() =>
                  saved.save(
                    saved.value.filter((v) => v.shortcut !== p.shortcut),
                  )
                }
                aria-label={`Remove ${p.shortcut}`}
              >
                Remove
              </button>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const next = [
                ...saved.value.filter((p) => p.shortcut !== shortcut),
                { shortcut, text: text.trim() },
              ];
              if (!isQuickPhrases(next)) {
                setError(
                  'Use a short lowercase shortcut and add instructions. Keep up to 50 phrases.',
                );
                return;
              }
              if (
                scanPrompt(text).findings.some((f) => f.severity === 'block')
              ) {
                setError('Remove sensitive credentials before saving.');
                return;
              }
              saved.save(next);
              setShortcut('');
              setText('');
              setError('');
            }}
          >
            <label>
              Shortcut
              <input
                value={shortcut}
                placeholder="review"
                maxLength={30}
                onChange={(e) => setShortcut(e.target.value.toLowerCase())}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={text}
                maxLength={10000}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <div className="eu-controls">
              <button disabled={!saved.loaded}>Save phrase</button>
            </div>
          </form>
          {(error || saved.error) && (
            <p role="alert" className="eu-error">
              {error || saved.error}
            </p>
          )}
        </EverydayDialog>
      )}
    </>
  );
}
