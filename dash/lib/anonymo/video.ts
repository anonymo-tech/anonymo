import { usdToMusd } from './money.ts';

export type VideoModel = {
  id: string;
  name: string;
  kind: 'video';
  pricing: { usd_per_second: string };
  seconds: { min: number; max: number; default?: number; allowed?: readonly number[] };
  sizes: string[];
};

export type VideoWelcome = { mode?: 'welcome' | 'complimentary'; available: boolean; eligible_clips: { model: string; seconds: number }[] };
export type VideoRequest = { model: string; prompt: string; seconds: number; size: string };
type StudioVerdict = 'safe' | 'unsafe' | 'unavailable';

export type VideoReceipt = {
  payload: {
    v: 1;
    kind: 'media';
    request_id: string;
    model_id: string;
    routes: string[];
    media_units: number;
    unit: 'second';
    cost_usd: number;
    outputs_sha256: string[];
    provenance: 'c2pa+watermark' | 'demo' | null;
    safety?: { prompt: StudioVerdict; outputs: { shieldgemma2: StudioVerdict; llavaguard: StudioVerdict }[] };
    ts: string;
  };
  key_id: string | null;
  sig: string | null;
};
export type VideoJob = Omit<VideoRequest, 'prompt'> & {
  id: string;
  object: 'video.generation';
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  created: number;
  url?: string;
  expires_at?: number;
  expired?: boolean;
  error?: { type: string; message: string };
  anonymo?: { request_id: string; cost_usd: number; quoted_usd: number; receipt?: VideoReceipt };
};

export function canRetryVideoFree(offer: VideoWelcome | null, clip: Pick<VideoRequest, 'model' | 'seconds'> | undefined) {
  return !!clip && !!offer?.available && offer.eligible_clips.some(item => item.model === clip.model && item.seconds === clip.seconds);
}

export function studioVideoModels(models: VideoModel[], offer: VideoWelcome | null) {
  if (offer?.mode !== 'complimentary') return models;
  if (!offer.available) return [];
  return models.filter(model => offer.eligible_clips.some(clip => clip.model === model.id));
}

export function videoDurations(model: VideoModel): readonly number[] {
  const { allowed, min, max } = model.seconds;
  return allowed ?? Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

export const videoCost = (model: VideoModel, seconds: number) => usdToMusd(model.pricing.usd_per_second) * seconds;
// Only the latest job ID is kept in the tab so a refresh can recover its authenticated status.
export const videoJobSlot = (demo: boolean) => demo ? 'anonymo.video-job.demo.v1' : 'anonymo.video-job.v1';
export const videoPending = (job: VideoJob) => job.status === 'queued' || job.status === 'in_progress';
export const videoBlocked = (job: VideoJob) =>
  job.status === 'failed' && ['explicit_media_unavailable', 'media_blocked', 'upstream_blocked', 'floor_blocked', 'region_blocked'].includes(job.error?.type ?? '');

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
export const formatVideoUsd = (usd: number) => dollars.format(usd);

/** Run one request at a time, and abort the current request when visibility or ownership changes. */
export function pollWhileVisible(
  page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>,
  poll: (signal: AbortSignal) => Promise<boolean>,
  intervalMs = 2500,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | null = null;
  let stopped = false;

  function schedule(delay = intervalMs) {
    clearTimeout(timer);
    if (!stopped && !page.hidden && !active) timer = setTimeout(run, delay);
  }

  function stop() {
    stopped = true;
    page.removeEventListener('visibilitychange', visibilityChanged);
    clearTimeout(timer);
    active?.abort();
  }

  async function run() {
    if (stopped || page.hidden) return;
    const attempt = new AbortController();
    active = attempt;
    try {
      if (!(await poll(attempt.signal)) && !attempt.signal.aborted) stop();
    } finally {
      active = null;
      schedule(attempt.signal.aborted ? 0 : intervalMs);
    }
  }

  function visibilityChanged() {
    if (page.hidden) active?.abort();
    schedule(0);
  }

  page.addEventListener('visibilitychange', visibilityChanged);
  schedule();
  return stop;
}
