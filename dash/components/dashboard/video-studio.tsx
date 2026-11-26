'use client';

import './video-studio.css';
import { StudioModelDialog } from './studio-model-dialog';
import { VideoShotIdeas } from './video-shot-ideas';
import { CopyButton } from '../copy-button';
import { loadKey } from '@/lib/anonymo/key-store';
import { dashboardSignup } from '@/lib/anonymo/dashboard-signup';
import { adultStore } from '@/lib/anonymo/prefs';
import { setupHref } from '@/lib/anonymo/setup-return';

import Link from 'next/link';
import { ChevronDown, Clock3, Download, Film, Proportions, Video } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AnonymoApiError, describeError, isOutOfCredit, type AnonymoClient } from '@/lib/anonymo/client';
import { canRetryVideoFree, formatVideoUsd, pollWhileVisible, videoBlocked, videoCost, videoDurations, videoJobSlot, videoPending, studioVideoModels, type VideoJob, type VideoModel, type VideoWelcome } from '@/lib/anonymo/video';
import { charactersStore } from '@/lib/anonymo/characters-store';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { studioPrompt } from '@/lib/anonymo/studio-presets';
import { updateOn } from '@/lib/anonymo/updates';
import { StudioCharacter } from './studio-character';
import { MUSD_PER_USD } from '@/lib/anonymo/money';
import { useAnonymo } from '../anonymo-provider';

const VIDEO_PROMPT_LIMIT = 2000;
const videoMarks: Record<string, string> = {
  alibaba: 'alibaba', kling: 'kling', bytedance: 'bytedance', google: 'google', lightricks: 'lightricks',
};

function ModelMark({ model }: { model: VideoModel }) {
  const logo = videoMarks[model.id.split('/')[0]];
  return <span className="image-brand" aria-hidden="true">{logo ? <img src={`/model-logos/${logo}.svg`} alt="" width="22" height="22" /> : <Film size={19} />}</span>;
}
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
  const { client, key, setKey } = useAnonymo();
  const [created, setCreated] = useState<{ key: string; workspace: number } | null>(null);
  let session = sessions.get(client);
  if (!session) {
    session = createSession();
    sessions.set(client, session);
  }
  const workspace = session.id;
  const justCreated = created !== null && key === created.key;
  return <VideoWorkspace key={justCreated ? created.workspace : workspace} client={client} session={session} created={justCreated}
    installKey={fresh => { setCreated({ key: fresh, workspace }); setKey(fresh, false); }} />;
}

function VideoWorkspace({ client, session, created, installKey }: {
  client: AnonymoClient; session: ReturnType<typeof createSession>; created: boolean; installKey: (key: string) => void;
}) {
  const { key, ready, refreshBalance, demo } = useAnonymo();
  const adult = useDeviceStore(adultStore);
  const slot = demo ? 'anonymo.video-model.demo.v1' : 'anonymo.video-model.v1';
  const [picker, setPicker] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [pickError, setPickError] = useState('');
  const [retry, setRetry] = useState(0);
  const [offer, setOffer] = useState<{ client: AnonymoClient; data: VideoWelcome } | null>(null);
  const [offerError, setOfferError] = useState(false);
  const [offerRevision, setOfferRevision] = useState(0);
  const refreshOffer = useCallback(() => { setOffer(null); setOfferRevision(n => n + 1); }, []);
  const currentOffer = offer?.client === client ? offer.data : null;
  const picking = useRef(false);
  const submitting = useRef(false);
  const initialized = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
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
  const [error, setError] = useState<{ text: string; funds: boolean; clip?: { model: string; seconds: number } } | null>(null);
  const jobs = useSyncExternalStore(session.subscribe, session.snapshot, () => EMPTY_JOBS);

  useEffect(() => {
    const request = new AbortController();
    if (!ready || !adult) return;
    setModelError(false);
    client.videoModels(request.signal).then(list => {
      if (request.signal.aborted) return;
      setModels(list);
      if (initialized.current) return;
      let saved = '';
      try { saved = localStorage.getItem(slot) ?? ''; } catch { /* Optional preference. */ }
      const known = list.some(entry => entry.id === saved);
      if (key && known) setModelId(saved);
      else setPicker(true);
      initialized.current = true;
    }, () => { if (!request.signal.aborted) setModelError(true); });
    return () => request.abort();
  }, [client, key, ready, adult, slot, retry]);

  useEffect(() => {
    if (!ready || !adult) return;
    const req = new AbortController();
    setOfferError(false);
    client.videoWelcome(req.signal).then(data => {
      if (!req.signal.aborted) setOffer({ client, data });
    }, () => { if (!req.signal.aborted) setOfferError(true); });
    return () => req.abort();
  }, [client, ready, adult, retry, offerRevision]);

  useEffect(() => {
    if (!key || session.snapshot().length) return;
    let id: string | null = null;
    try { id = sessionStorage.getItem(videoJobSlot(demo)); } catch { /* Storage is optional. */ }
    if (!id) return;
    const req = new AbortController();
    client.videoStatus(id, req.signal).then(job => {
      if (!req.signal.aborted) { session.save(job); refreshOffer(); }
    }).catch(() => { /* The job can expire or belong to a previous key. */ });
    return () => req.abort();
  }, [key, demo, client, session, refreshOffer]);

  async function pickModel(id: string) {
    if (picking.current) return;
    picking.current = true;
    setPickError('');
    setPreparing(true);
    try {
      if (!loadKey(demo)) {
        const fresh = await client.createKey({ dashboard_signup: await dashboardSignup(demo) });
        if (!loadKey(demo)) installKey(fresh.key);
      }
      setModelId(id);
      setLength(undefined);
      try { localStorage.setItem(slot, id); } catch { /* Keep the selection in memory. */ }
      setPicker(false);
      requestAnimationFrame(() => editor.current?.focus({ preventScroll: true }));
    } catch (cause) {
      setPickError(describeError(cause));
    } finally { picking.current = false; setPreparing(false); }
  }

  const complimentary = currentOffer?.mode === 'complimentary';
  const choices = studioVideoModels(models ?? [], currentOffer);
  const model = choices.find(m => m.id === modelId) ?? (complimentary ? choices[0] : undefined);
  const coverageUnavailable = complimentary && !!models && choices.length === 0;
  const freeClips = currentOffer?.available ? currentOffer.eligible_clips : [];
  const freeLength = freeClips.find(clip => clip.model === model?.id)?.seconds;
  const lengths = complimentary && freeLength ? [freeLength] : model ? videoDurations(model) : [];
  const seconds = length != null && lengths.includes(length) ? length : freeLength ?? model?.seconds.default ?? lengths[0];
  const sponsored = !!freeLength && seconds === freeLength;
  const size = model?.sizes.includes(shapeSize) ? shapeSize : model?.sizes[0];
  const quote = model ? formatVideoUsd(videoCost(model, seconds) / MUSD_PER_USD) : null;

  const text = studioOn ? studioPrompt(prompt, 'clip', character?.card.data) : prompt.trim();
  const tooLong = studioOn && text.length > VIDEO_PROMPT_LIMIT;

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (coverageUnavailable) return;
    if (!model || !key) { setPicker(true); return; }
    if (!seconds || !size || !text || tooLong || submitting.current || !currentOffer || (complimentary && !sponsored)) return;
    submitting.current = true;
    setLength(seconds);
    setSending(true);
    setError(null);
    try {
      const job = await (sponsored ? client.sponsoredVideo : client.generateVideo)({ model: model.id, prompt: text, seconds, size });
      session.save(job);
      try { sessionStorage.setItem(videoJobSlot(demo), job.id); } catch { /* The job remains in memory. */ }
      setPrompt((draft) => draft.trim() === prompt.trim() ? '' : draft);
    } catch (cause) {
      const text = cause instanceof AnonymoApiError && cause.status === 451
        ? 'Video request blocked. Nothing was charged.'
        : describeError(cause);
      setError({ text, funds: !complimentary && isOutOfCredit(cause), clip: sponsored ? { model: model.id, seconds } : undefined });
    } finally {
      submitting.current = false;
      setSending(false);
      if (sponsored) refreshOffer();
      refreshBalance();
    }
  }

  return (
    <div className="image-workspace video-workspace">
      <header className="image-heading"><h1>Video studio</h1><p>Turn a scene and a camera move into a silent clip.</p></header>
      {picker && adult && <StudioModelDialog kind="video" selected={model?.id ?? modelId} loading={!models && !modelError}
        busy={preparing} error={pickError || (modelError ? 'Couldn’t load video models.' : null)}
        subtitle={complimentary ? 'Anonymo covers short clips for this account.' : freeClips.length ? 'Pick a model to make your first short clip on us.' : 'Choose a model for your shot.'}
        choices={choices.map(entry => {
          const allowed = videoDurations(entry);
          const free = freeClips.find(clip => clip.model === entry.id);
          return { id: entry.id, name: entry.name, mark: <ModelMark model={entry} />,
            description: complimentary && free ? `${free.seconds}-second clip` : `${entry.seconds.allowed && allowed.length <= 3 ? allowed.join(', ') : allowed[0] + '–' + allowed.at(-1)}s · ${formatVideoUsd(Number(entry.pricing.usd_per_second))}/s`,
            price: free ? `${free.seconds}s free` : undefined };
        })}
        onRetry={() => { setPickError(''); setRetry(n => n + 1); }}
        onPick={id => void pickModel(id)} onClose={() => setPicker(false)} />}
    <div className="studio video-studio">
      <form className="studio-panel" onSubmit={generate}>
        <label className="field"><span className="image-field-label">Describe your shot</span>
          <textarea ref={editor} className="textarea studio-prompt" rows={4} value={prompt} maxLength={VIDEO_PROMPT_LIMIT}
            placeholder="What happens in the scene? How does the camera move?" onChange={event => setPrompt(event.target.value)} />
        </label>
        {tooLong && <p className="muted">Shorten your description to leave room for the character details.</p>}
        <div className="image-controls">
          <button type="button" className="image-model-trigger" disabled={coverageUnavailable} onClick={() => setPicker(true)}>
            {model ? <ModelMark model={model} /> : <Film size={15} />}<span>{model?.name ?? (coverageUnavailable ? 'No covered models' : 'Choose a model')}</span><ChevronDown size={14} />
          </button>
          {model && <>
            <label className="aspect-select"><Clock3 size={15} /><select aria-label="Duration" value={seconds} onChange={e => setLength(Number(e.target.value))}>
              {lengths.map(value => <option key={value} value={value}>{value}s{freeLength === value ? ' · Free' : ''}</option>)}</select></label>
            <label className="aspect-select"><Proportions size={15} /><select aria-label="Aspect ratio" value={size} onChange={e => setShapeSize(e.target.value)}>
              {model.sizes.map(value => <option key={value} value={value}>{value === '1280x720' ? '16:9' : value === '720x1280' ? '9:16' : shape(value)}</option>)}</select></label>
          </>}
        </div>
        {studioOn && (characters.length > 0) && <details className="studio-options field-help"><summary>Character <span>{character?.card.data.name ?? 'Optional'}</span><ChevronDown size={14} /></summary>
          <div className="studio-options-fields"><StudioCharacter characters={characters} selected={character?.id ?? ''} onChange={setCharacterId} /></div>
        </details>}
        {coverageUnavailable && <p role="status">No covered clips are available right now. <button type="button" onClick={refreshOffer}>Refresh</button></p>}
        {(offerError || modelError) && <p role="alert">Couldn’t load {modelError ? 'video models' : 'video pricing'}. <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
        <button className="btn btn-primary studio-go" type="submit" disabled={!text || tooLong || sending || preparing || coverageUnavailable || (!!model && !currentOffer)}>
          <Video size={17} />{sending ? 'Submitting…' : coverageUnavailable ? 'Clips unavailable' : !model ? 'Choose a model' : sponsored ? 'Generate free clip' : 'Generate clip'}
          {model && !sponsored && currentOffer && quote && <span className="studio-cost" aria-label={`Estimated cost ${quote}`}>{quote}</span>}
        </button>
        {error && (
          <div className="notice" role="alert">
            {error.text} {canRetryVideoFree(currentOffer, error.clip) && 'Your free clip is still available.'} {error.funds && <Link href={setupHref('funds', '/dashboard/video')}>Add funds</Link>}
          </div>
        )}
      </form>
      <section className="studio-board" aria-label="Video previews">
        {jobs.length === 0 ? <VideoShotIdeas onPick={idea => { setPrompt(idea); editor.current?.focus(); }} /> : <>
          <h2 className="image-results-title">Your clips</h2>
          {jobs.map(job => <VideoJobCard key={job.id} job={job} client={client}
            modelName={models?.find(m => m.id === job.model)?.name ?? job.model} save={session.save}
            refreshBalance={refreshBalance} refreshOffer={refreshOffer} demo={demo}
            freeRetry={job.status === 'failed' && job.anonymo?.quoted_usd === 0 && canRetryVideoFree(currentOffer, job)} />)}
          {created && key && <CopyButton text={key} label="Copy your key" className="btn btn-small video-copy-key" />}
        </>}
      </section>
    </div>
    <p className="image-policy">Video generation is safe for work. Download clips to keep them.</p>
    </div>
  );
}

function VideoJobCard({ job, client, modelName, save, refreshBalance, refreshOffer, demo, freeRetry }: {
  job: VideoJob;
  client: AnonymoClient;
  modelName: string;
  save: (job: VideoJob) => void;
  refreshBalance: () => void;
  refreshOffer: () => void;
  demo: boolean;
  freeRetry: boolean;
}) {
  const [connection, setConnection] = useState('');
  const [playbackError, setPlaybackError] = useState(false);
  const [checkingDelivery, setCheckingDelivery] = useState(false);
  const pending = videoPending(job);
  const id = job.id;

  useEffect(() => {
    if (!pending && !checkingDelivery) return;
    return pollWhileVisible(document, async (signal) => {
      try {
        const current = await client.videoStatus(id, signal);
        if (signal.aborted) return true;
        setConnection('');
        if (current.status !== job.status || current.can_retry_delivery !== job.can_retry_delivery) save(current);
        if (videoPending(current)) return true;
      } catch (error) {
        if (signal.aborted) return true;
        if (error instanceof AnonymoApiError && error.status === 451) {
          save({ ...job, status: 'failed', error: { type: 'upstream_blocked', message: 'Video request blocked. Nothing was charged.' } });
        } else if (error instanceof AnonymoApiError && [401, 403, 404].includes(error.status)) {
          setCheckingDelivery(false);
          setConnection('Video status is unavailable.');
          return false;
        } else {
          setConnection('Reconnecting…');
          return true;
        }
      }
      setCheckingDelivery(false);
      refreshBalance();
      refreshOffer();
      return false;
    });
  }, [client, id, job, pending, checkingDelivery, refreshBalance, refreshOffer, save]);

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
        job.can_retry_delivery ? <div className="video-job-footer">
          <p className="video-job-note" role="status">Your render is ready at the provider. Delivery was interrupted.</p>
          <button type="button" className="btn btn-small" disabled={checkingDelivery} onClick={() => setCheckingDelivery(true)}>
            {checkingDelivery ? 'Checking…' : 'Recover clip'}
          </button>
        </div> : <p className="video-job-note" role="status">{blocked ? 'Video request blocked.' : 'Video generation failed.'} {freeRetry ? 'Your free clip is still available.' : 'Nothing was charged.'}</p>
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
