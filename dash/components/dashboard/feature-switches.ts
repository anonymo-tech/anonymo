/**
 * Workspace features require explicit owner approval. Projects, Canvas, Library,
 * Decisions, Help, updates 06–15 and More models are approved. FOMO is approved; other Second Look tools remain held. Keep these
 * static switches aligned with feature-releases.json; the build verifies them.
 */
export const FEATURE_SWITCHES = {
  frontRow: false,
  modelPanels: false,
  modelFinder: false,
  quickPhrases: false,
  recall: false,
  takeaway: false,
  sayIt: false,
  readToMe: false,
  flywheel: true,
  moreModels: true,
  secondLook: true,
  projects: true,
  canvas: true,
  library: true,
  decisions: true,
  help: true,
  routes: true,
  purse: true,
  receipts: true,
  crosscheck: true,
  synthesis: true,
  explainer: true,
  studio: true,
  chapters: true,
  agents: true,
  connections: true,
} satisfies Record<string, boolean>;

export type FeatureName = keyof typeof FEATURE_SWITCHES;

export const featureOn = (name: FeatureName): boolean => FEATURE_SWITCHES[name];
