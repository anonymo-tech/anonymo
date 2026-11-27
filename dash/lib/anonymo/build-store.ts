// Updates "build" and "research": what was made, kept in this browser only (localStorage under the `anonymo.` prefix,
// so Wipe and the panic key remove it with everything else). Nothing is stored by Anonymo.

import { deviceStore, readJson, writeJson } from './device-store.ts';
import type { Citation } from './search.ts';

export type BuildVersion = { ask: string; html: string; complete: boolean; at: string };
export type SavedBuild = { id: string; title: string; model: string; versions: BuildVersion[]; at: string };

export type SavedReport = {
  id: string;
  question: string;
  depth: 'quick' | 'deep';
  writer: string;
  searches: string[];
  report: string;
  sources: Citation[];
  at: string;
};

const BUILDS = 'anonymo.builds';
const REPORTS = 'anonymo.research';
const MAX_BUILDS = 12;
const MAX_VERSIONS = 6;
const MAX_REPORTS = 30;

const isBuild = (b: unknown): b is SavedBuild =>
  !!b && typeof b === 'object' && typeof (b as SavedBuild).id === 'string' && Array.isArray((b as SavedBuild).versions);
const isReport = (r: unknown): r is SavedReport =>
  !!r && typeof r === 'object' && typeof (r as SavedReport).id === 'string' && typeof (r as SavedReport).report === 'string';

export const buildsStore = deviceStore<SavedBuild[]>(() => {
  const list = readJson<unknown>(BUILDS, []);
  return Array.isArray(list) ? list.filter(isBuild) : [];
}, []);

export const reportsStore = deviceStore<SavedReport[]>(() => {
  const list = readJson<unknown>(REPORTS, []);
  return Array.isArray(list) ? list.filter(isReport) : [];
}, []);

const closed = () => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-anonymo-panic');

/** Keep a build, newest first. When the browser is out of room the oldest builds are dropped until it fits. */
export function saveBuild(build: SavedBuild): boolean {
  if (closed()) return false;
  const trimmed = { ...build, versions: build.versions.slice(-MAX_VERSIONS) };
  let list = [trimmed, ...buildsStore.get().filter((b) => b.id !== build.id)].slice(0, MAX_BUILDS);
  while (!writeJson(BUILDS, list)) {
    if (list.length > 1) list = list.slice(0, -1);
    else if (list[0].versions.length > 1) list = [{ ...list[0], versions: list[0].versions.slice(-1) }];
    else return false;
  }
  buildsStore.changed();
  return true;
}

export function removeBuild(id: string) {
  writeJson(BUILDS, buildsStore.get().filter((b) => b.id !== id));
  buildsStore.changed();
}

export function saveReport(report: SavedReport): boolean {
  if (closed()) return false;
  let list = [report, ...reportsStore.get().filter((r) => r.id !== report.id)].slice(0, MAX_REPORTS);
  while (list.length && !writeJson(REPORTS, list)) list = list.slice(0, -1);
  reportsStore.changed();
  return list.length > 0;
}

export function removeReport(id: string) {
  writeJson(REPORTS, reportsStore.get().filter((r) => r.id !== id));
  reportsStore.changed();
}
