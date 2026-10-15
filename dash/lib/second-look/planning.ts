/** Account-scoped planning. Saving a plan never signs or submits a trade. */
export type CoolHeadSettings = {
  enabled: boolean;
  timezone: string;
  dailyBudgetUsd6: string | null;
};

export type ExitPlanInput = {
  walletId: string;
  mint: string;
  takeProfit: { priceUsd: string; sizeBps: number } | null;
  stopLoss: { priceUsd: string; sizeBps: number } | null;
  trailingBps: number | null;
};
export type SavedExitPlan = ExitPlanInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
  mode: 'reminder';
  status: 'awaiting_feed';
};
export type PlanningResponse = {
  revision: number;
  coolHead: CoolHeadSettings;
  exitPlans: SavedExitPlan[];
  capabilities: {
    priceWatch: false;
    notificationDelivery: false;
    executesTrades: false;
    behaviorHistory: false;
  };
};
