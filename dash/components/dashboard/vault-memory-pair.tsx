'use client';

import { useState, type FormEvent } from 'react';
import { Copy, QrCode } from 'lucide-react';
import { readMemorySecret } from '@/lib/anonymo/memory-secret';
import { encodeQr, qrPath, QR_QUIET_ZONE } from '@/lib/anonymo/qr';
import { answerPairing, newPairing } from '@/lib/anonymo/vault-memory/crypto';
import { bringVaultMemory } from '@/lib/anonymo/vault-memory/store';

type Pairing = Awaited<ReturnType<typeof newPairing>>;
type Detector = { detect: (image: ImageBitmap) => Promise<{ rawValue: string }[]> };
const detector = () => (globalThis as typeof globalThis & {
  BarcodeDetector?: new (options: { formats: string[] }) => Detector;
}).BarcodeDetector;

export function PairDevices({ demo, hasMemories, joined }: { demo: boolean; hasMemories: boolean; joined: () => void }) {
  const [mode, setMode] = useState<'receive' | 'send' | null>(null);
  const [request, setRequest] = useState<Pairing | null>(null);
  const [response, setResponse] = useState('');
  const [secret, setSecret] = useState<Uint8Array | null>(null);
  const [entry, setEntry] = useState('');
  const [allowSwitch, setAllowSwitch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    try { await operation(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Pairing could not be completed.'); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      if (mode === 'receive' && request) {
        const received = secret ?? await request.accept(entry);
        setSecret(received);
        await bringVaultMemory(demo, received, [], allowSwitch);
        setSecret(null);
        joined();
      }
      if (mode === 'send') {
        const secret = await readMemorySecret(demo);
        if (!secret) throw new Error('Open Vault Memory on this device first.');
        setResponse(await answerPairing(entry, secret));
      }
    });
  }

  async function scan(file: File) {
    const BarcodeDetector = detector();
    if (!BarcodeDetector) return;
    const bitmap = await createImageBitmap(file);
    try {
      const [match] = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bitmap);
      if (!match) throw new Error('No QR code was found. You can paste the pairing code instead.');
      setEntry(match.rawValue);
    } finally { bitmap.close(); }
  }

  const code = mode === 'receive' ? request?.code : response;
  const qr = code ? encodeQr(code) : null;
  const side = qr ? qr.size + QR_QUIET_ZONE * 2 : 0;

  return (
    <div className="vault-fields">
      <div className="row">
        <button className="btn btn-small" type="button" disabled={busy} onClick={() => void run(async () => {
          setSecret(null);
          setAllowSwitch(false);
          setRequest(await newPairing());
          setMode('receive');
          setEntry('');
          setResponse('');
        })}>This is the new device</button>
        <button className="btn btn-small" type="button" disabled={busy} onClick={() => {
          setRequest(null); setSecret(null); setMode('send'); setEntry(''); setResponse(''); setNotice('');
        }}>This device has the memories</button>
      </div>
      {mode === 'receive' && <p className="muted">Share this request with your other device. You have five minutes to enter its response here.</p>}
      {mode === 'send' && <p className="muted">Enter the request from the new device. Share the response only with that device.</p>}
      {qr && code && (
        <div className="memory-pair-code">
          <svg width="148" height="148" viewBox={`0 0 ${side} ${side}`} role="img" aria-label={mode === 'send' ? 'Pairing response QR' : 'Pairing request QR'} shapeRendering="crispEdges">
            <rect width={side} height={side} fill="#fff" />
            <path d={qrPath(qr)} fill="#24092a" />
          </svg>
          <label className="field">
            <span>{mode === 'send' ? 'Pairing response' : 'Pairing request'}</span>
            <input className="input" value={code} readOnly onFocus={(event) => event.target.select()} />
          </label>
          <button className="btn btn-small" type="button" onClick={() => void run(async () => {
            await navigator.clipboard.writeText(code);
            setNotice('Code copied.');
          })}><Copy size={14} /> Copy code</button>
        </div>
      )}
      {mode && !response && (
        <form className="vault-fields" onSubmit={submit}>
          <label className="field">
            <span>{mode === 'receive' ? 'Response from your other device' : 'Request from your new device'}</span>
            <input className="input" value={entry} maxLength={200} autoComplete="off" spellCheck={false} onChange={(event) => setEntry(event.target.value)} />
          </label>
          {typeof window !== 'undefined' && detector() && <label className="field">
            <span><QrCode size={14} /> Scan a QR image</span>
            <input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void run(() => scan(file));
            }} />
          </label>}
          {mode === 'receive' && hasMemories && <label className="vault-check">
            <input type="checkbox" checked={allowSwitch} onChange={(event) => setAllowSwitch(event.target.checked)} />
            Switch vaults if this device already has a different one
          </label>}
          <div className="row">
            <button className="btn btn-primary btn-small" disabled={busy || !entry.trim()}>{mode === 'receive' ? 'Join memory vault' : 'Create response'}</button>
          </div>
        </form>
      )}
      {notice && <output className="muted" role="status">{notice}</output>}
    </div>
  );
}
