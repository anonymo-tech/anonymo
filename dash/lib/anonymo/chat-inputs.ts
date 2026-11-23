// Switches for the mobile chat-input features (brief IDs 01, 02, 03, 06, 07). Each is an update in updates.ts: on in
// demo mode, off in a live build until NEXT_PUBLIC_ANONYMO_UPDATES names it (or says "all") or it is RELEASED.

import { updateOn, type UpdateId } from './updates.ts';

export const CHAT_INPUT_FEATURES = ['01', '02', '03', '06', '07'] as const;
export type ChatInputFeature = (typeof CHAT_INPUT_FEATURES)[number];

/** The update switch behind each brief ID. */
export const CHAT_INPUT_UPDATE = { '01': 'mask', '02': 'circle', '03': 'excerpt', '06': 'safepost', '07': 'proof' } as const satisfies Record<ChatInputFeature, UpdateId>;

export const chatInputOn = (id: ChatInputFeature, demo: boolean) => updateOn(CHAT_INPUT_UPDATE[id], demo);
