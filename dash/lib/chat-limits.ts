/** Transport envelope for one prompt. The model's own context limit is enforced by the gateway. */
export const CHAT_LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
});
