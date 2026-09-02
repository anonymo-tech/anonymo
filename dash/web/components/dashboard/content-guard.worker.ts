import {
  handleGuardRequest,
  type GuardWorkerResponse,
} from '../../lib/guards/worker.ts';

export { scanPrompt, scanText } from '../../lib/guards/index.ts';
export { handleGuardRequest } from '../../lib/guards/worker.ts';

declare const self: {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (response: GuardWorkerResponse) => void;
};

if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = (event) => self.postMessage(handleGuardRequest(event.data));
}
