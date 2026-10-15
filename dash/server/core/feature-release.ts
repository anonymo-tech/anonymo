import { secondLookPathOn } from '../../lib/second-look/releases.ts';
import {
  featureOn,
  type FeatureName,
} from '../../components/dashboard/feature-switches.ts';
import { modelReleased } from '../../lib/model-release.ts';
import { modelForFamily } from '../ppq/catalog.ts';
import { ServiceError } from './errors.ts';

const atOrBelow = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`);

/**
 * Runtime configuration cannot release a held product feature. This check runs
 * before configuration, sessions, database work, webhooks and streamed content.
 * /routes and /balance remain core chat dependencies; the separate routing
 * recommendations and funding/history surfaces remain behind their gates.
 */
export function endpointFeature(
  path: string,
): FeatureName | 'tokenFunding' | null {
  if (atOrBelow(path, 'flywheel')) return 'flywheel';
  if (atOrBelow(path, 'second-look')) return 'secondLook';
  if (atOrBelow(path, 'media')) return 'studio';
  if (atOrBelow(path, 'crosscheck')) return 'crosscheck';
  if (atOrBelow(path, 'receipts')) return 'receipts';
  if (atOrBelow(path, 'auto-route-quotes')) return 'routes';
  if (atOrBelow(path, 'ledger') || atOrBelow(path, 'deposits')) return 'purse';
  // USDC Purse approval does not release token-denominated funding or burns.
  // Those endpoints need their own approved release switch before activation.
  if (atOrBelow(path, 'token')) return 'tokenFunding';
  if (
    atOrBelow(path, 'pre-sign-inspections') ||
    atOrBelow(path, 'program-inspections') ||
    atOrBelow(path, 'explanations')
  )
    return 'explainer';
  if (
    atOrBelow(path, 'brief-syntheses') ||
    atOrBelow(path, 'briefs/synthesis') ||
    /^briefs\/[^/]+\/synthes(?:is|es)(?:\/|$)/.test(path)
  )
    return 'synthesis';
  for (const feature of ['chapters', 'agents', 'connections'] as const) {
    if (atOrBelow(path, feature)) return feature;
  }
  return null;
}

export function assertEndpointReleased(path: string, method = 'GET'): void {
  if (atOrBelow(path, 'second-look') && !secondLookPathOn(path, method)) {
    throw new ServiceError(404, 'FEATURE_UNAVAILABLE', 'This feature is not available.');
  }
  const feature = endpointFeature(path);
  if (feature && (feature === 'tokenFunding' || !featureOn(feature))) {
    throw new ServiceError(
      404,
      'FEATURE_UNAVAILABLE',
      'This feature is not available.',
    );
  }
}

/** A family label alone must never release a different, held provider model. */
export function releasedChatRoute(route: {
  family: string;
  model_id: string;
}): boolean {
  return (
    modelReleased(route.family) &&
    modelForFamily(route.family) === route.model_id
  );
}
