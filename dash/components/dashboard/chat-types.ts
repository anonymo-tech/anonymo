import type { CouncilResult, Receipt } from '@/lib/anonymo/types';
import type { MemoryCharge } from '@/lib/anonymo/memory-request';

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
  aiReminder?: boolean; // show the 3-hourly “you’re talking to an AI” reminder above this turn
  crisis?: boolean; // the prompt mentioned suicide or self-harm: show crisis lines with the answer
  recap?: boolean; // update "catchup": this turn is a recap of an earlier chat, sent as context at the start of this one
  memoryCharge?: MemoryCharge;
  answeredBy?: string | null; // update "auto": the model that answered an anonymo-auto turn
  autoClass?: string | null; // update "auto": the kind of request it read (x-anonymo-auto)
  search?: boolean; // update "search": sent as `<model>:online`
  citations?: { url: string; title: string }[]; // update "search": the sources the answer cites
  photos?: string[]; // update "photos": the photos sent with this message, as data URLs, in this tab's memory only
  photoCount?: number; // how many photos went with it; saved chats keep this and a "photo not saved" placeholder
};
