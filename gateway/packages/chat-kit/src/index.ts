// @anonymo/chat-kit: an embeddable, white-label React chat for Anonymo.
export { AnonymoChat, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type AnonymoChatProps } from "./AnonymoChat";
export { ChatMessage, ModelPicker, PrivacyLabel, ReceiptLink, acceptsImages, type ChatMessageProps, type ModelPickerProps, type PrivacyLabelProps, type ReceiptLinkProps } from "./components";
export { HistoryPanel, type HistoryPanelProps } from "./HistoryPanel";
export { Markdown, CopyButton } from "./Markdown";
export { parseBlocks, parseInline, safeHref, type Block, type Span } from "./markdown-parse";
export { useAnonymoChat, chosenModel, makeId, type UseAnonymoChatOptions, type UseAnonymoChat, type ChatStatus, type ResolvedModel } from "./useAnonymoChat";
export { ChatError, apiUrl, applyChunk, getJson, receiptLane, retryAfterMs, sseEvents, streamChat, wireMessage, type ClientOptions, type FetchLike, type KeySource, type StreamChunk, type StreamResult } from "./client";
export {
  createEncryptedHistory,
  generateViewingKey,
  browserStorage,
  indexedDBStorage,
  localStorageStorage,
  memoryStorage,
  isSealed,
  titleOf,
  HistoryError,
  HISTORY_VERSION,
  ITERATIONS,
  MIN_PASSPHRASE,
  PBKDF2,
  RAW_KEY,
  type CustomKdf,
  type EncryptedHistory,
  type HistoryErrorCode,
  type HistoryOptions,
  type HistoryStorage,
  type SavedChat,
  type ChatSummary,
  type SealedHistory,
  type ViewingSecret,
} from "./history";
export { fetchPrivacyLabel, normalizeLabel, isReceiptId, privacyPath, receiptHref, LABEL_FIELDS } from "./privacy";
export { CHAT_KIT_CSS, THEMES, THEME_VARS, STYLE_ELEMENT_ID, injectStyles, type ThemeName, type ColorScheme, type ThemeVar } from "./styles";
export type { Attachment, ChatMessage as ChatMessageData, MessageStatus, ModelInfo, PrivacyLabelData, Receipt, Usage } from "./types";
