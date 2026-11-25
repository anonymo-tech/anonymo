import { deviceStore, readJson, writeJson } from './device-store.ts';

const REGION_KEY = 'anonymo.declared-region.v1';
let declaredHere: string | undefined;

export function parseRegionDeclaration(value: string) {
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(code) && !/^(?:XX|ZZ)(?:-|$)/.test(code) ? code : null;
}

export const declaredRegionStore = deviceStore(() => declaredHere ?? readJson(REGION_KEY, ''), '');

export function declareRegion(value: string) {
  declaredHere = writeJson(REGION_KEY, value) ? undefined : value;
  declaredRegionStore.changed();
}
