import type { CouncilResult, Receipt } from '@/lib/anonymo/types';

/** One question and its answer. Lives in memory only: the workspace never stores prompt or output text. */
export type Turn = {
  id: string;
  model: string;
  prompt: string; // what the person typed (the PDF text, if any, is not kept here)
  attachment: string | null; // PDF name, if one was attached
  character: string | null; // character name, for anonymo-rp
  content: string;
  status: 'streaming' | 'done' | 'stopped' | 'error';
  error: string | null;
  needsFunds?: boolean; // the error was a balance too low for the request: offer the Funds page
  receiptId: string | null;
  receipt: Receipt | null;
  council: CouncilResult | null;
  councilMode: 'merge' | 'select' | null;
};
