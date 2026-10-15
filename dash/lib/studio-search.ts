import type { MediaJob } from './client/media.ts';
export const STUDIO_JOB_GROUPS = ['all', 'saved', 'progress', 'attention', 'cancelled', 'deleted'] as const;
export type StudioJobGroup = typeof STUDIO_JOB_GROUPS[number];
export function studioJobGroup(job: MediaJob): Exclude<StudioJobGroup, 'all'> {
  if (job.mediaAssetState === 'stored') return 'saved';
  if (job.mediaAssetState === 'deleted') return 'deleted';
  if (job.mediaAssetState === 'unavailable' || job.processingState === 'failed' || job.state === 'failed' || job.state === 'reconciliation_pending') return 'attention';
  if (job.state === 'cancelled') return 'cancelled';
  return 'progress';
}
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
export function filterStudioJobs(jobs: readonly MediaJob[], query: string, model: string, group: StudioJobGroup) {
  const search = normalize(query);
  return jobs.filter(job => job.modality === 'video' && (!model || job.modelId === model) &&
    (group === 'all' || studioJobGroup(job) === group) &&
    (!search || normalize(job.input.prompt).includes(search) || normalize(job.modelId).includes(search)));
}
