'use client';

import { setupHref } from '@/lib/anonymo/setup-return';

import Link from 'next/link';
import { Download, Film, ShieldCheck } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AnonymoApiError, describeError, isOutOfCredit, type AnonymoClient } from '@/lib/anonymo/client';
import { formatVideoUsd, pollWhileVisible, videoBlocked, videoCost, videoDurations, videoPending, type VideoJob, type VideoModel } from '@/lib/anonymo/video';
import { charactersStore } from '@/lib/anonymo/characters-store';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { studioPrompt } from '@/lib/anonymo/studio-presets';
import { updateOn } from '@/lib/anonymo/updates';
import { StudioCharacter } from './studio-character';
import { MUSD_PER_USD } from '@/lib/anonymo/money';
import { useAnonymo } from '../anonymo-provider';

const VIDEO_PROMPT_LIMIT = 2000;
const SAMPLE_PROMPT = 'A ribbon of pink and amber light drifting across a deep violet sky, slow camera movement.';
const EMPTY_JOBS: VideoJob[] = [];
const sessions = new WeakMap<AnonymoClient, ReturnType<typeof createSession>>();
let nextSession = 0;

// Retain recent jobs across workspace navigation for this client. Draft prompts stay in the form.
function createSession() {
  let jobs = EMPTY_JOBS;
  const listeners = new Set<() => void>();
  return {
    id: ++nextSession,
    snapshot: () => jobs,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    save(job: VideoJob) {
      jobs = jobs.some((prior) => prior.id === job.id)
        ? jobs.map((prior) => prior.id === job.id ? job : prior)
        : [job, ...jobs];
      // Keep active jobs polling even if they are older than the recent results.
      let finished = 0;
      jobs = jobs.filter((entry) => videoPending(entry) || ++finished <= 12);
      listeners.forEach((listener) => listener());
    },
  };
}

function shape(size: string) {
  const [width, height] = size.split('x').map(Number);
  if (size === '1280x720') return 'Landscape · 16:9';
  if (size === '720x1280') return 'Portrait · 9:16';
  return `${width > height ? 'Landscape' : 'Portrait'} · ${width} × ${height}`;
}

export function VideoStudio() {
  const { client, key } = useAnonymo();
  if (!key) return (
    <div className="notice row">
      <span>Connect an API key to generate video.</span>
      <Link className="btn btn-primary btn-small" href={setupHref('key', '/dashboard/video')}>Create a key</Link>
    </div>
  );
  let session = sessions.get(client);
  if (!session) {
    session = createSession();
    sessions.set(client, session);
  }
  return <VideoWorkspace key={session.id} client={client} session={session} />;
}

function VideoWorkspace({ client, session }: { client: AnonymoClient; session: ReturnType<typeof createSession> }) {
  const { refreshBalance, demo } = useAnonymo();
  const studioOn = updateOn('studio', demo);
  const characters = useDeviceStore(charactersStore);
  const [characterId, setCharacterId] = useState('');
  const character = characters.find((entry) => entry.id === characterId);
  const [models, setModels] = useState<VideoModel[] | null>(null);
  const [modelError, setModelError] = useState(false);
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [length, setLength] = useState<number>();
  const [shapeSize, setShapeSize] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ text: string; funds: boolean } | null>(null);
  const jobs = useSyncExternalStore(session.subscribe, session.snapshot, () => EMPTY_JOBS);

  useEffect(() => {
    const request = new AbortController();
    client.videoModels(request.signal).then(
      (list) => { if (!request.signal.aborted) setModels(list); },
      () => { if (!request.signal.aborted) setModelError(true); },
    );
    return () => request.abort();
  }, [client]);

  const model = models?.find((m) => m.id === modelId) ?? models?.[0];
  const lengths = model ? videoDurations(model) : [];
  const seconds = length != null && lengths.includes(length) ? length : model?.seconds.default ?? lengths[0];
  const size = model?.sizes.includes(shapeSize) ? shapeSize : model?.sizes[0];
  const quote = model ? formatVideoUsd(videoCost(model, seconds) / MUSD_PER_USD) : null;

  const text = studioOn ? studioPrompt(prompt, 'clip', character?.card.data) : prompt.trim();
  const tooLong = studioOn && text.length > VIDEO_PROMPT_LIMIT;

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!model || !seconds || !size || !text || tooLong || sending) return;
    setSending(true);
    setError(null);
    try {
      session.save(await client.generateVideo({ model: model.id, prompt: text, seconds, size }));
      setPrompt((draft) => draft.trim() === prompt.trim() ? '' : draft);
    } catch (cause) {
      const text = cause instanceof AnonymoApiError && cause.status === 451
        ? 'Video request blocked. Nothing was charged.'
        : describeError(cause);
      setError({ text, funds: isOutOfCredit(cause) });
    } finally {
      setSending(false);
      refreshBalance();
    }
  }

  return (
    <div className="studio video-studio">
      <form className="studio-panel" onSubmit={generate}>
        {studioOn && <StudioCharacter characters={characters} selected={character?.id ?? ''} onChange={setCharacterId} />}
        <label className="field">
          <span>Prompt</span>
          <textarea className="textarea studio-prompt" value={prompt} maxLength={VIDEO_PROMPT_LIMIT} placeholder={SAMPLE_PROMPT} onChange={(event) => setPrompt(event.target.value)} />
        </label>
        {tooLong && <p className="muted">Shorten your description to leave room for the clip and character details.</p>}
        {demo && !prompt && <div className="studio-ideas"><button type="button" className="chip" onClick={() => setPrompt(SAMPLE_PROMPT)}>Use a sample prompt</button></div>}

        <label className="field">
          <span>Model</span>
          <select className="select" value={model?.id ?? ''} disabled={!model} onChange={(event) => {
            setModelId(event.target.value);
            setLength(undefined);
          }}>
            {!model && <option value="">{modelError ? 'Could not load video models' : models ? 'No video models available' : 'Loading models…'}</option>}
            {models?.map((m) => <option key={m.id} value={m.id}>{m.name} · {formatVideoUsd(Number(m.pricing.usd_per_second))}/s</option>)}
          </select>
        </label>

        {model && (
          <div className="video-options">
            <label className="field">
              <span>Length</span>
              <select className="select" value={seconds} onChange={(event) => setLength(Number(event.target.value))}>
                {lengths.map((value) => <option key={value} value={value}>{value} seconds</option>)}
              </select>
            </label>
            <label className="field">
              <span>Shape</span>
              <select className="select" value={size} onChange={(event) => setShapeSize(event.target.value)}>
                {model.sizes.map((value) => <option key={value} value={value}>{shape(value)}</option>)}
              </select>
            </label>
          </div>
        )}

        <button className="btn btn-primary studio-go" type="submit" disabled={!model || !text || tooLong || sending}>
          {sending ? 'Submitting…' : 'Generate video'} {quote && <span className="studio-cost" aria-label={`Estimated cost ${quote}`}>{quote}</span>}
        </button>
        {error && (
          <div className="notice" role="alert">
            {error.text} {error.funds && <Link href={setupHref('funds', '/dashboard/video')}>Add funds</Link>}
          </div>
        )}
        <p className="studio-note"><ShieldCheck size={15} aria-hidden="true" /> Safe for work only.</p>
      </form>

      <section className="studio-board" aria-labelledby="video-recent">
        <h2 id="video-recent" className="video-board-title">Recent jobs</h2>
        {jobs.length === 0 ? (
          <div className="studio-empty">
            <Film size={30} aria-hidden="true" />
            <strong>Your clips will appear here</strong>
          </div>
        ) : jobs.map((job) => (
          <VideoJobCard key={job.id} job={job} client={client} modelName={models?.find((m) => m.id === job.model)?.name ?? job.model}
            save={session.save} refreshBalance={refreshBalance} demo={demo} />
        ))}
      </section>
    </div>
  );
}

function VideoJobCard({ job, client, modelName, save, refreshBalance, demo }: {
  job: VideoJob;
  client: AnonymoClient;
  modelName: string;
  save: (job: VideoJob) => void;
  refreshBalance: () => void;
  demo: boolean;
}) {
  const [connection, setConnection] = useState('');
  const [playbackError, setPlaybackError] = useState(false);
  const pending = videoPending(job);
  const id = job.id;

  useEffect(() => {
    if (!pending) return;
    return pollWhileVisible(document, async (signal) => {
      try {
        const current = await client.videoStatus(id, signal);
        if (signal.aborted) return true;
        setConnection('');
        if (current.status !== job.status) save(current);
        if (videoPending(current)) return true;
      } catch (error) {
        if (signal.aborted) return true;
        if (error instanceof AnonymoApiError && error.status === 451) {
          save({ ...job, status: 'failed', error: { type: 'upstream_blocked', message: 'Video request blocked. Nothing was charged.' } });
        } else if (error instanceof AnonymoApiError && [401, 403, 404].includes(error.status)) {
          setConnection('Video status is unavailable.');
          return false;
        } else {
          setConnection('Reconnecting…');
          return true;
        }
      }
      refreshBalance();
      return false;
    });
  }, [client, id, job, pending, refreshBalance, save]);

  const blocked = videoBlocked(job);
  const status = job.status === 'queued' ? 'Queued' : job.status === 'in_progress' ? 'Generating' : job.status === 'completed' ? 'Complete' : blocked ? 'Blocked' : 'Failed';
  const expired = job.expired || (job.expires_at != null && job.expires_at * 1000 <= Date.now());
  const url = job.url && !expired ? client.videoMediaUrl(job.url) : null;
  const receipt = job.anonymo?.receipt;
  const download = url && `${url}${url.includes('?') ? '&' : '?'}download=1`;
  return (
    <article className="shot video-job">
      <header>
        <div><h3>{modelName}</h3><p className="muted">{job.seconds}s · {shape(job.size)}</p></div>
        <span className="chip" role="status">{status}</span>
      </header>
      {pending && <div className="video-wait" aria-hidden="true"><Film size={30} /></div>}
      {connection && <p className="video-job-note" role="status">{connection}</p>}
      {job.status === 'failed' && (
        <p className="video-job-note" role="status">{blocked ? 'Video request blocked.' : 'Video generation failed.'} Nothing was charged.</p>
      )}
      {job.status === 'completed' && (
        <>
          {url && !playbackError ? (
            <video aria-label={demo ? 'Demo video preview' : 'Generated video'} controls muted playsInline preload="metadata" src={url} onError={() => setPlaybackError(true)} />
          ) : <p className="video-job-note">{expired ? 'The video link expired.' : 'The video preview is unavailable.'}</p>}
          <div className="video-job-footer">
            <span>{demo && 'Demo preview · '}{formatVideoUsd(job.anonymo?.cost_usd ?? 0)} charged</span>
            <div className="shot-actions">
              {download && <a className="btn btn-small" href={download} download={`${id}.mp4`} rel="noreferrer"><Download size={14} aria-hidden="true" /> Download</a>}
              {receipt && <a className="btn btn-small" href={`data:application/json,${encodeURIComponent(JSON.stringify(receipt, null, 2))}`} download={`${id}-receipt.json`}>Receipt</a>}
            </div>
          </div>
        </>
      )}
    </article>
  );
}
