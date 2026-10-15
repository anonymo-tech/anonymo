/** Minimal history shape: prompts and model output are never retained by the tally. */
export type BlindRecordComparison = {
  id: string;
  blind: boolean;
  votedCallId: string | null;
  calls: { id: string; family: string | null }[];
};
export type BlindRecordRow = {
  family: string;
  picked: number;
  appeared: number;
  pickRate: number;
};
export type BlindRecordTally = {
  votes: number;
  unattributed: number;
  rows: BlindRecordRow[];
};

export const BLIND_RECORD_LIMITS = { pagesPerProject: 20, comparisons: 500 } as const;
export const isSmallBlindSample = (votes: number): boolean => votes < 10;

export function tallyBlindPicks(comparisons: readonly BlindRecordComparison[]): BlindRecordTally {
  const seen = new Set<string>();
  const rows = new Map<string, BlindRecordRow>();
  let votes = 0;
  let unattributed = 0;
  for (const comparison of comparisons) {
    if (!comparison.blind || !comparison.votedCallId || seen.has(comparison.id)) continue;
    seen.add(comparison.id);
    votes++;
    const winner = comparison.calls.find(call => call.id === comparison.votedCallId);
    if (!winner?.family) unattributed++;
    // An appearance is one voted comparison, even with two versions of a family.
    for (const family of new Set(comparison.calls.map(call => call.family))) {
      if (!family) continue;
      const row = rows.get(family) ?? { family, picked: 0, appeared: 0, pickRate: 0 };
      row.appeared++;
      if (winner?.family === family) row.picked++;
      rows.set(family, row);
    }
  }
  return {
    votes,
    unattributed,
    rows: [...rows.values()].map(row => ({ ...row, pickRate: row.picked / row.appeared }))
      .sort((a, b) => b.picked - a.picked || a.family.localeCompare(b.family)),
  };
}

type Page<T> = { items: T[]; nextCursor: string | null };
type HistoryClient = {
  projects: (after?: string | null) => Promise<Page<{ id: string }>>;
  comparisons: (projectId: string, after?: string | null) => Promise<Page<BlindRecordComparison>>;
};
export type BlindRecordProgress = { projects: number; comparisons: number; votes: number };
export type BlindRecordResult = BlindRecordTally & {
  scanned: number;
  pageCapReached: boolean;
  comparisonCapReached: boolean;
};

/** Read only, sequential scan. The caller supplies the existing account-bound client. */
export async function countBlindRecord(
  client: HistoryClient,
  signal: AbortSignal,
  onProgress: (progress: BlindRecordProgress) => void,
): Promise<BlindRecordResult> {
  const history: BlindRecordComparison[] = [];
  const projectIds = new Set<string>();
  const projectCursors = new Set<string>();
  let projectCursor: string | null = null;
  let projects = 0;
  let scanned = 0;
  let pageCapReached = false;
  do {
    signal.throwIfAborted();
    const projectPage = await client.projects(projectCursor);
    signal.throwIfAborted();
    for (const project of projectPage.items) {
      if (projectIds.has(project.id)) continue;
      projectIds.add(project.id);
      let cursor: string | null = null;
      const cursors = new Set<string>();
      for (let page = 0; page < BLIND_RECORD_LIMITS.pagesPerProject; page++) {
        signal.throwIfAborted();
        const comparisons = await client.comparisons(project.id, cursor);
        signal.throwIfAborted();
        const items = comparisons.items.slice(0, BLIND_RECORD_LIMITS.comparisons - scanned);
        scanned += items.length;
        // Keep only the fields used by the tally, never prompts or responses.
        history.push(...items.map(item => ({
          id: item.id, blind: item.blind, votedCallId: item.votedCallId,
          calls: item.calls.map(call => ({ id: call.id, family: call.family })),
        })));
        onProgress({ projects, comparisons: scanned, votes: tallyBlindPicks(history).votes });
        if (scanned === BLIND_RECORD_LIMITS.comparisons) {
          return { ...tallyBlindPicks(history), scanned, pageCapReached, comparisonCapReached: true };
        }
        cursor = comparisons.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor)) throw new Error('Repeated comparison cursor');
        cursors.add(cursor);
        if (page === BLIND_RECORD_LIMITS.pagesPerProject - 1) pageCapReached = true;
      }
      projects++;
      onProgress({ projects, comparisons: scanned, votes: tallyBlindPicks(history).votes });
    }
    projectCursor = projectPage.nextCursor;
    if (projectCursor && projectCursors.has(projectCursor)) throw new Error('Repeated project cursor');
    if (projectCursor) projectCursors.add(projectCursor);
  } while (projectCursor);
  return { ...tallyBlindPicks(history), scanned, pageCapReached, comparisonCapReached: false };
}
