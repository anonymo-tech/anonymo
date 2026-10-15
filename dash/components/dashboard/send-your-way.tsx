'use client';

import { useDeviceSetting } from './use-device-setting';
import { validChatSendKey, type ChatSendKey } from '../../lib/chat-send-key';
import '@/app/dashboard/send-your-way.css';

export function useSendYourWay(scope: string, enabled: boolean) {
  return useDeviceSetting<ChatSendKey>(`conclave-send-key-v1:${scope}`, 'enter', validChatSendKey, enabled);
}
export function SendYourWay({ setting }: { setting: ReturnType<typeof useSendYourWay> }) {
  return <div className="cw-send-your-way">
    <label>Send with <select aria-label="Send with" value={setting.value} onChange={event => {
      if (validChatSendKey(event.target.value)) setting.save(event.target.value);
    }}><option value="enter">Enter</option><option value="modifier">⌘ / Ctrl + Enter</option></select></label>
    <span>{setting.value === 'enter' ? 'Shift + Enter for a new line' : 'Enter for a new line'}</span>
    {setting.error && <output>{setting.error}</output>}
  </div>;
}
