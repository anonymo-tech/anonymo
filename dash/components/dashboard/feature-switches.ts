/**
 * Feature switches for the workspace. Every feature beyond Chat ships behind its
 * own switch, and every switch is off, so the public build shows Chat, sign-in
 * and settings only. To turn a feature on, set its value to true: its entry
 * points, deep links and in-chat actions appear with it.
 */
export const FEATURE_SWITCHES = {
  projects: false,
  canvas: false,
  library: false,
  decisions: false,
  help: false,
  routes: false,
  purse: false,
  receipts: false,
  crosscheck: false,
  synthesis: false,
  explainer: false,
  studio: false,
  chapters: false,
  agents: false,
} satisfies Record<string, boolean>;

export type FeatureName = keyof typeof FEATURE_SWITCHES;

export const featureOn = (name: FeatureName): boolean => FEATURE_SWITCHES[name];
