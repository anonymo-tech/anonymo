'use client';

// Public trust pages (Overview §2 "Proof, not promises", Backend §11): the model manifest and the refusal leaderboard,
// read from the gateway's GET /manifest, GET /v1/models and GET /leaderboard.

import { useCallback, useEffect, useState } from 'react';
import { useAnonymo } from './anonymo-provider';
import { describeError } from '@/lib/anonymo/client';
import type { Leaderboard, Manifest, ModelInfo } from '@/lib/anonymo/types';

const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`);
const shortHash = (h: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');

function useLoad<T>(load: (() => Promise<T>) | null) {
  const [state, setState] = useState<{ data: T | null; error: string }>({ data: null, error: '' });
  useEffect(() => {
    if (!load) return;
    let live = true;
    load().then(
      (data) => live && setState({ data, error: '' }),
      (e: unknown) => live && setState({ data: null, error: describeError(e) }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return state;
}

export function ManifestView() {
  const { ready, client } = useAnonymo();
  const loadManifest = useCallback(() => client.manifest(), [client]);
  const loadModels = useCallback(() => client.models().then((m) => m.data), [client]);
  const manifest = useLoad<Manifest>(ready ? loadManifest : null);
  const models = useLoad<ModelInfo[]>(ready ? loadModels : null);
  return (
    <div className="panel-stack">
      <section className="section" style={{ marginTop: 0 }}>
        <h2>Model IDs</h2>
        {models.error && <p className="notice notice-rose">{models.error}</p>}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>ID</th>
                <th>Family</th>
                <th>Quant</th>
                <th>Weights hash</th>
                <th>Attested</th>
                <th className="num">Refusals, 30 days</th>
              </tr>
            </thead>
            <tbody>
              {(models.data ?? []).map((m) => (
                <tr key={m.id}>
                  <td className="mono">{m.id}</td>
                  <td>{m.family ?? <span className="faint">router</span>}</td>
                  <td className="mono">{m.quant ?? '—'}</td>
                  <td className="hash" title={m.weights_hash ?? undefined}>{shortHash(m.weights_hash)}</td>
                  <td>{m.attested ? <span className="chip chip-signal">attested</span> : <span className="faint">no</span>}</td>
                  <td className="num">{pct(m.refusal_rate_30d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="faint">
          Router IDs (anonymo-1, -rp, -council, -sealed) span several routes; direct IDs are listed only for routes that do not
          run on Venice. Venice models are never relabelled one-for-one.
        </p>
      </section>
      <section className="section">
        <h2>Routes</h2>
        {manifest.error && <p className="notice notice-rose">{manifest.error}</p>}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Route</th>
                <th>Tier</th>
                <th>Family</th>
                <th>Quant</th>
                <th>Weights hash</th>
                <th>Attested</th>
                <th>Serves</th>
              </tr>
            </thead>
            <tbody>
              {(manifest.data?.routes ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td className="mono">{r.tier}</td>
                  <td>{r.family}</td>
                  <td className="mono">{r.quant}</td>
                  <td className="hash" title={r.weights_hash ?? 'Not published by this upstream'}>{shortHash(r.weights_hash)}</td>
                  <td>{r.attested ? <span className="chip chip-signal">attested</span> : <span className="faint">no</span>}</td>
                  <td className="mono faint">{r.serves.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {manifest.data && <p className="faint">Generated {new Date(manifest.data.generated_at).toLocaleString()}.</p>}
      </section>
    </div>
  );
}

export function LeaderboardView() {
  const { ready, client } = useAnonymo();
  const loadBoard = useCallback(() => client.leaderboard(), [client]);
  const board = useLoad<Leaderboard>(ready ? loadBoard : null);
  const max = Math.max(0.0001, ...(board.data?.rows ?? []).map((r) => r.refusal_rate));
  return (
    <div className="panel-stack">
      {board.error && <p className="notice notice-rose">{board.error}</p>}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Route</th>
              <th>Family</th>
              <th className="num">Requests</th>
              <th className="num">Refused</th>
              <th className="num">Rate</th>
              <th style={{ width: '22%' }}>
                <span className="sr-only">Rate bar</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(board.data?.rows ?? []).map((r, i) => (
              <tr key={r.route_id}>
                <td className="mono faint">{i + 1}</td>
                <td className="mono">{r.route_id}</td>
                <td>{r.family}</td>
                <td className="num">{r.total.toLocaleString()}</td>
                <td className="num">{r.refused.toLocaleString()}</td>
                <td className="num">{pct(r.refusal_rate)}</td>
                <td>
                  <span className="sr-only">{pct(r.refusal_rate)} of requests refused</span>
                  <div className="rate-bar" aria-hidden="true">
                    <span style={{ width: `${(r.refusal_rate / max) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {board.data && (
        <p className="faint">
          Last {board.data.window_days} days, counted from refusal events (counts only, no text). Every refused attempt was
          rerouted and billed 0. Updated {new Date(board.data.generated_at).toLocaleString()}.
        </p>
      )}
    </div>
  );
}
