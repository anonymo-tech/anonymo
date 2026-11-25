import { solveFreeWork } from './free-chat.ts';

self.onmessage = async ({ data }: MessageEvent<{ challenge: string; difficulty: number; expires: number }>) => {
  const nonce = await solveFreeWork(data.challenge, data.difficulty, data.expires);
  self.postMessage(nonce);
};
