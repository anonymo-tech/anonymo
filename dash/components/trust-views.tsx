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
                  <td>{m.family ?? <span className="faint">several</span>}</td>
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
        {manifest.data && (
          <p className="faint">
            {manifest.data.counts.models} models · {manifest.data.counts.routes} routes · {manifest.data.counts.attested_routes} attested now ·{' '}
            {manifest.data.counts.families} families
          </p>
        )}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Model</th>
                <th>Route</th>
                <th>Family</th>
                <th>Quant</th>
                <th>Weights hash</th>
                <th>Attested</th>
              </tr>
            </thead>
            <tbody>
              {(manifest.data?.models ?? []).flatMap((m) =>
                m.routes.map((r) => (
                  <tr key={`${m.id}|${r.route}`}>
                    <td className="mono">{m.id}</td>
                    <td className="mono">{r.route}</td>
                    <td>{r.family}</td>
                    <td className="mono">{r.quant ?? '—'}</td>
                    <td className="hash" title={r.weights_hash ?? 'Not stated for this route'}>{shortHash(r.weights_hash)}</td>
                    <td>
                      {r.attested ? (
                        <span className="chip chip-signal" title={r.attestation_hash ?? undefined}>
                          attested{r.tee ? ` · ${r.tee}` : ''}
                        </span>
                      ) : (
                        <span className="faint">no</span>
                      )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
        {manifest.data && (
          <>
            {manifest.data.notes.map((n) => (
              <p key={n} className="faint">
                {n}
              </p>
            ))}
            <p className="faint">Generated {new Date(manifest.data.generated_at).toLocaleString()}.</p>
          </>
        )}
      </section>
    </div>
  );
}

export function LeaderboardView() {
  const { ready, client } = useAnonymo();
  const loadBoard = useCallback(() => client.leaderboard(), [client]);
  const board = useLoad<Leaderboard>(ready ? loadBoard : null);
  const rows = board.data?.routes ?? [];
  const max = Math.max(0.0001, ...rows.map((r) => r.refusal_rate_30d ?? 0));
  return (
    <div className="panel-stack">
      {board.error && <p className="notice notice-rose">{board.error}</p>}
      {board.data && (!board.data.available || rows.length === 0) && (
        <p className="notice">No refusal counts yet. Rates appear once routes have served requests.</p>
      )}
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
            {rows.map((r, i) => (
              <tr key={r.route}>
                <td className="mono faint">{i + 1}</td>
                <td className="mono">{r.route}</td>
                <td>{r.family}</td>
                <td className="num">{r.total_30d.toLocaleString()}</td>
                <td className="num">{r.refused_30d.toLocaleString()}</td>
                <td className="num">{pct(r.refusal_rate_30d)}</td>
                <td>
                  <span className="sr-only">{pct(r.refusal_rate_30d)} of requests refused</span>
                  <div className="rate-bar" aria-hidden="true">
                    <span style={{ width: `${((r.refusal_rate_30d ?? 0) / max) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(board.data?.families.length ?? 0) > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Family</th>
                <th className="num">Requests</th>
                <th className="num">Refused</th>
                <th className="num">Rate</th>
              </tr>
            </thead>
            <tbody>
              {board.data!.families.map((f) => (
                <tr key={f.family}>
                  <td>{f.family}</td>
                  <td className="num">{f.total_30d.toLocaleString()}</td>
                  <td className="num">{f.refused_30d.toLocaleString()}</td>
                  <td className="num">{pct(f.refusal_rate_30d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {board.data && (
        <p className="faint">
          Last {board.data.window_days} days, counted from refusal events (counts only, no text). Every refused attempt was
          rerouted and billed 0. Updated {new Date(board.data.generated_at).toLocaleString()}.
        </p>
      )}
    </div>
  );
}
