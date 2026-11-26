import { MUSD_PER_USD } from '../money.ts';
import { videoCost, videoDurations, videoPending, type VideoJob, type VideoRequest } from '../video.ts';
import { DEMO_VIDEO_MODELS } from './fixtures.ts';
import { DEMO_NUDITY } from './images.ts';

const QUEUE_MS = 1800;
const GENERATION_MS = 4200;
const UPLOAD_FIELD = /^(?:(?:input|reference|first|last|start|end|source)?(?:image|video|audio)s?(?:url|dataurl|attachmentid|file)?|inputreference|(?:first|last|start|end)frame|references?)$/i;

export type DemoVideoEntry = { job: VideoJob; cost: number; start: number };

export function createDemoVideo<Key extends { firstVideo?: DemoVideoEntry }>(o: {
  now: () => number;
  id: () => string;
  json: (body: unknown, status?: number) => Response;
  fail: (status: number, type: string, message: string) => Response;
  check: (key: Key, cost: number) => Response | null;
  remaining: () => number;
  sponsor: (key: Key, entry: DemoVideoEntry) => void;
  save: () => void;
  charge: (key: Key, cost: number, job: VideoJob) => void;
}) {
  const jobs = new WeakMap<Key, Map<string, DemoVideoEntry>>();
  function welcome(key?: Key) {
    const clips = DEMO_VIDEO_MODELS.map(model => ({ model: model.id, seconds: videoDurations(model)[0], cost: videoCost(model, videoDurations(model)[0]) }))
      .filter(clip => clip.cost <= o.remaining() && clip.cost <= 750_000)
      .map(({ model, seconds }) => ({ model, seconds }));
    const available = (!key?.firstVideo || key.firstVideo.job.status === 'failed') && clips.length > 0;
    return { available, eligible_clips: available ? clips : [] };
  }
  return {
    welcome,
    async submit(request: Request, key: Key, sponsored = false) {
      const body = (await request.json().catch(() => null)) as Partial<VideoRequest> | null;
      const model = DEMO_VIDEO_MODELS.find((m) => m.id === body?.model);
      if (!model || !body) return o.fail(404, 'model_not_found', 'Unknown video model.');
      if (Object.entries(body).some(([field, value]) => value != null && UPLOAD_FIELD.test(field.replace(/[_-]/g, ''))))
        return o.fail(400, 'video_uploads_not_supported', 'Video takes a text prompt only.');
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 2000)
        return o.fail(400, 'invalid_request', 'Enter a prompt of 1–2,000 characters.');
      if (DEMO_NUDITY.test(body.prompt))
        return o.fail(451, 'explicit_media_unavailable', 'Video request blocked. Nothing was charged.');
      const seconds = body.seconds ?? model.seconds.default ?? model.seconds.min;
      if (!videoDurations(model).includes(seconds)) return o.fail(400, 'invalid_duration', 'Choose a length this model offers.');
      const size = body.size ?? model.sizes[0];
      if (!model.sizes.includes(size)) return o.fail(400, 'invalid_size', 'Choose a shape this model offers.');
      const cost = videoCost(model, seconds);
      if (sponsored && seconds !== videoDurations(model)[0]) return o.fail(400, 'first_video_options', 'Choose the free short duration.');
      if (sponsored && !welcome(key).eligible_clips.some(clip => clip.model === model.id))
        return o.fail(409, 'first_video_unavailable', 'The free clip is unavailable. Nothing was charged.');
      const refusal = sponsored ? null : o.check(key, cost);
      if (refusal) return refusal;
      const start = o.now();
      const job: VideoJob = { id: o.id(), object: 'video.generation', model: model.id, status: 'queued', created: Math.floor(start / 1000), seconds, size };
      const recent = jobs.get(key) ?? new Map();
      const entry = { job, cost, start };
      if (sponsored) o.sponsor(key, entry);
      recent.set(job.id, entry);
      jobs.set(key, recent);
      return o.json(job, 202);
    },
    status(id: string, key: Key) {
      const sponsored = key.firstVideo?.job.id === id;
      const entry = sponsored ? key.firstVideo : jobs.get(key)?.get(id);
      if (!entry) return o.fail(404, 'not_found', 'Unknown video job.');
      const { job, cost, start } = entry;
      const elapsed = o.now() - start;
      if (!videoPending(job) || elapsed < QUEUE_MS) return o.json(job);
      if (elapsed < QUEUE_MS + GENERATION_MS) {
        job.status = 'in_progress';
        return o.json(job);
      }
      const costUsd = sponsored ? 0 : cost / MUSD_PER_USD;
      job.anonymo = { request_id: job.id, cost_usd: 0, quoted_usd: costUsd };
      if (!sponsored && o.check(key, cost)) {
        job.status = 'failed';
        job.error = { type: 'insufficient_balance', message: 'This job ran out of available credit. Nothing was charged.' };
        return o.json(job);
      }
      if (!sponsored) o.charge(key, cost, job);
      job.status = 'completed';
      job.url = job.size === '720x1280' ? '/demo/video-portrait.mp4' : '/demo/video.mp4';
      job.anonymo.cost_usd = costUsd;
      job.anonymo.receipt = {
        payload: {
          v: 1, kind: 'media', request_id: job.id, model_id: job.model, routes: ['demo:video'],
          media_units: job.seconds, unit: 'second', cost_usd: costUsd, outputs_sha256: [], provenance: 'demo', ts: new Date(o.now()).toISOString(),
        },
        key_id: null, sig: null,
      };
      if (sponsored) o.save();
      return o.json(job);
    },
  };
}
