'use client';

import { MoVoiceLink } from './mo-voice-link';
import { characterDestination, setupHref } from '@/lib/anonymo/setup-return';
import { chatSetupStep, clearSetupDraft, readSetupMessage, writeSetupDraft, type ChatSetupStep } from '@/lib/anonymo/chat-setup';

import { MascotSprite } from '../mascot-sprite';
import { Photo } from '@/components/photo';
import { InstallAppCard } from '@/components/phone-app';
import Link from 'next/link';
import { ArrowUp, Crop, Drama, ImageIcon, ShieldCheck, SlidersHorizontal, Square, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { mightBeWalletRequest, parseWalletRequest, WALLET_REVIEW_DRAFT } from '@/lib/anonymo/wallet-request';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isLiveModel, useAnonymo } from '../anonymo-provider';
import { AnswerCard } from './answer-card';
import { ChatVoiceContext, VoiceSettings, useChatVoice } from './chat-voice';
import { VoiceMic } from './voice-mic';
import { FaceAvatar, TurnFace, hasFace, useFaces } from './face';
import { Stage, StageTools } from './stage';
import { ChatBar, ChatHistoryPanel } from './chat-history';
import type { Turn } from './chat-types';
import { ModelPicker } from './model-picker';
import { MemorySuggestions, useChatMemory } from './memory-chat';
import { PaperTrail } from './paper-trail';
import { ShareChat } from './share-chat';
import { PhotoButton, PhotoTrayView, TurnPhotos, usePhotos } from './chat-photos';
import { scanFailed, useContentGuard } from './use-content-guard';
import { MaskReview, MaskedPrompt } from './mask-review';
import { AttachmentEditor, type EditorSource } from './attachment-editor';
import { SafePostEditor } from './safe-post-editor';
import type { ProofSource } from '@/lib/anonymo/citations';
import { decodeImage, type DecodedImage } from '@/lib/anonymo/attachment-image';
import { DEFAULT_QUESTION, excerptBody, excerptContent, excerptMessage, type Excerpt, type ExcerptPurpose } from '@/lib/anonymo/excerpt';
import { createPortal } from 'react-dom';
import { buildCharacterMessages, greetingsOf } from '@/lib/anonymo/card';
import { charactersStore } from '@/lib/anonymo/characters-store';
import { memoryFor } from '@/lib/anonymo/movein/store';
import { useFreeChat } from './use-free-chat';
import { freeContext } from '@/lib/anonymo/free-chat';
import type { EverydayAccess } from '@/lib/anonymo/everyday';
import { AnonymoApiError, describeError, isOutOfCredit } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { chatModels, isAnonymoModel, publishedPpqChat } from '@/lib/anonymo/chat-models';
import { adultStore, chatModelStore, setChatModel } from '@/lib/anonymo/prefs';
import type { ChatMessage, ChatPhotoMessage, MediaImageModel } from '@/lib/anonymo/types';
import { attachPhotos, photoHint, photoSupport, withPhotoNote } from '@/lib/anonymo/photos';
import { paperPrompt, type PaperSource } from '@/lib/paper-trail';
import { AI_REMINDER } from '@/lib/anonymo/safety';
import { CompanionDisclosure, CrisisNotice, RegionPage, useCompanionCompliance } from './companion-compliance';
import { keepStore, saveChat } from '@/lib/anonymo/history';
import { canRecap, recapContext, recapRequest, suggestRecap, threadTokens } from '@/lib/anonymo/catchup';
import { BUILT_WITH, updateOn } from '@/lib/anonymo/updates';
import { setChatLimit } from '@/lib/anonymo/pricetag-store';
import { PriceTag, usePriceTag } from './price-tag';
import { isAutoModel } from '@/lib/anonymo/auto';
import { onlineModel, WEB_SEARCH_PRICE_USD } from '@/lib/anonymo/search';
import { SearchToggle } from './web-sources';
import { chatInputOn } from '@/lib/anonymo/chat-inputs';
import { MaskVault, addMask, maskSegments, masksFromFindings, payloadDigest, sanitizedSlice, segmentsText, toggleMask, type Mask } from '@/lib/anonymo/masking';
import { withAboutYou } from '@/lib/anonymo/about-you';
import { currentAboutYouNote, loadAboutYouForChat, useAboutYouNote } from '@/lib/anonymo/about-you-store';

import { ChatModeComposer, type ActiveTool } from './chat-mode-composer';
import { ChatModeSettings, MODE_LABELS } from './chat-mode-settings';
import { ChatModeTurn, modeCharges } from './chat-mode-turn';
import { giveStudioDraft } from './image-studio-draft';
import { streamComparison } from './side-by-side-session';
import { ANSWER_MAX_TOKENS, EMPTY_ROUND, MERGE_MAX_TOKENS, MERGE_MODEL, SLOTS, canMerge, mergeRequest, mergeable, reconcileSlots, roundReducer, slotModels, type RoundAction, type SlotId } from '@/lib/anonymo/sidebyside';
import { IMAGE_PROMPT_LIMIT, flatEstimate, imageError, imageModels, modeHint, pictureEstimate, reconcilePicture, recordingEstimate, threeEstimate, type ChatMode, type ModePrefs, type ModeResult } from '@/lib/anonymo/chat-modes';
import { setModePrefs, useModePrefs } from '@/lib/anonymo/chat-mode-prefs';
import { speechRate, transcriptionRate } from '@/lib/anonymo/talk';
import { checkLimit, estimateMessage, parseUsdAtto, priceLabel, spentLabel, usdText, type Atto } from '@/lib/anonymo/pricetag';

const MODE_STARTERS: Record<ChatMode, string> = {
  picture: 'Draw a fox in the rain, moody and cinematic.',
  three: 'Which AI is best at writing poems?',
  talk: 'Can we talk out loud for a bit?',
};

const STARTERS = [
  'Give me three ideas for a short mystery story.',
  'Help me turn a rough idea into a plan.',
];

function tabStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function ChatWorkspace({ compact, threadHost, composerHost }: {
  compact: boolean;
  threadHost: HTMLDivElement | null;
  composerHost: HTMLDivElement | null;
}) {
  const { ready, demo, key, client, turns, setTurns, chatId, openChat, rememberReceipt, balance, refreshBalance, liveModels, catalog, catalogError, refreshCatalog } = useAnonymo();
  const adult = useDeviceStore(adultStore);
  const freeMode = ready && adult && !key && updateOn('free', demo);
  const free = useFreeChat(client, freeMode, demo);
  const freeExhausted = freeMode && free.remaining === 0;
  const stored = useDeviceStore(chatModelStore);
  const directModels = useMemo(() => chatModels(catalog ?? []), [catalog]);
  // Update "auto": Auto is offered only while the update is on; a stored Auto choice falls back to anonymo-1 otherwise.
  const autoOn = ready && updateOn('auto', demo);
  const branded = isAnonymoModel(stored) || isAutoModel(stored);
  const model = (branded && !isLiveModel(liveModels, stored)) || (isAutoModel(stored) && !autoOn) ? 'anonymo-1' : stored;
  const modelReady = branded ? isLiveModel(liveModels, model) : directModels.some(m => m.id === model && m.availability !== 'temporarily_unavailable');
  // Features 02/03: a crop goes as an image only to a direct model whose catalog row lists image input.
  const visionModel = !branded && !!directModels.find((m) => m.id === model)?.architecture?.input_modalities?.includes('image');
  const requestedCharacter = useSearchParams().get('character');
  const [councilMode, setCouncilMode] = useState<'merge' | 'select'>('merge');
  const [refusalCatch, setRefusalCatch] = useState(true);
  // Update "search": "Search the web" sends the model as `<model>:online` (sealed, council and :private never search).
  const searchOn = ready && !freeMode && updateOn('search', demo);
  const [webSearch, setWebSearch] = useState(false);
  const [text, setText] = useState(() => {
    const last = turns.at(-1);
    return last?.needsFunds && !last.attachment && !last.recap ? last.prompt : '';
  });
  const modesOn = ready && !compact && updateOn('modes', demo);
  const [selectedMode, setSelectedMode] = useState<ChatMode | null>(null);
  const [menu, setMenu] = useState(false);
  const [audioCosts, setAudioCosts] = useState<(string | null)[]>([]);
  const [imageCatalog, setImageCatalog] = useState<{ client: typeof client; models: MediaImageModel[] } | null>(null);
  const prefs = useModePrefs(demo);
  const imagesOn = modesOn && !compact && model !== 'anonymo-sealed' && updateOn('images', demo);
  useEffect(() => {
    if (!imagesOn) return;
    let current = true;
    client.mediaModels().then((list) => {
      if (current) setImageCatalog({ client, models: imageModels(list) });
    }, () => {
      if (current) setImageCatalog(null);
    });
    return () => { current = false; };
  }, [client, imagesOn]);
  const images = imagesOn && imageCatalog?.client === client ? imageCatalog.models : [];
  const comparisonModels = useMemo(() => slotModels((catalog ?? []).filter((entry) =>
    entry.id !== 'anonymo-sealed' && entry.availability !== 'temporarily_unavailable')), [catalog]);
  const slots = reconcileSlots(prefs.three.models, comparisonModels);
  const mergeReady = comparisonModels.some((entry) => entry.id === MERGE_MODEL);
  const [setupSheet, setSetupSheet] = useState<{ step: ChatSetupStep; hasAttachment: boolean; saved: boolean; freeUpsell: boolean } | null>(null);
  const [waitingDraft, setWaitingDraft] = useState(false);
  const setupAction = useRef<HTMLAnchorElement>(null);
  const voiceOn = ready && updateOn('talk', demo);
  const voice = useChatVoice({
    enabled: voiceOn && !!key, discover: voiceOn && (!!key || (modesOn && !compact)), client, chatId, turns, refreshBalance,
    onAudio: (id, change) => update(id, (turn) => {
      const result = turn.modeResult;
      if (result?.mode !== 'talk') return {};
      return { modeResult: {
        ...result,
        audioPending: change.pending ?? result.audioPending,
        audioReceipts: change.receipt ? [...(result.audioReceipts ?? []), change.receipt] : result.audioReceipts,
        audioCosts: change.cost === undefined ? result.audioCosts : [...result.audioCosts, change.cost],
      } };
    }),
    canRead: (turn, quote) => price.limit === null ||
      (!!turn.receipt && !checkLimit(price.limit, price.spend, flatEstimate(quote)).blocked),
  });
  const availableModes: ChatMode[] = [];
  if (modesOn && !compact && model !== 'anonymo-sealed') {
    if (images.length) availableModes.push('picture');
    if (updateOn('sidebyside', demo) && slots.length === SLOTS.length) availableModes.push('three');
    if (modelReady && voice.transcription && voice.speech?.voices.length) availableModes.push('talk');
  }
  const mode = modesOn && model !== 'anonymo-sealed' ? selectedMode : null;
  const guestChat = freeMode && !mode;
  const modeReady = !mode || availableModes.includes(mode);
  const refusalTool = !guestChat && (branded || mode === 'three');
  const settings: ModePrefs = {
    picture: reconcilePicture(prefs.picture, images),
    three: { models: slots, merged: prefs.three.merged && mergeReady },
    talk: { ...prefs.talk, voice: voice.speech?.voices.includes(prefs.talk.voice) ? prefs.talk.voice : (voice.speech?.voices[0] ?? '') },
  };
  const hint = modesOn && !mode ? modeHint(text, availableModes) : null;
  const imageModel = images.find((image) => image.id === settings.picture.model);
  const [paper, setPaper] = useState<PaperSource | null>(null);
  // Update "photos": only a model that lists image input gets them; the tray lives in this tab's memory only.
  const photosOn = ready && !freeMode && updateOn('photos', demo);
  const support = useMemo(() => photoSupport(model, directModels), [model, directModels]);
  const tray = usePhotos(support);
  const characters = useDeviceStore(charactersStore);
  const [characterId, setCharacterId] = useState<string | null>(requestedCharacter);
  // `redacted` is empty when there is no safe redacted version to offer (the check itself failed).
  const [guardNote, setGuardNote] = useState<{ redacted: string; message: string } | null>(null);
  // Feature 01 "Mask my details": the draft under review, its masks and an undo stack. The vault maps this chat's
  // placeholders back to the original values, in memory only.
  const maskOn = ready && chatInputOn('01', demo);
  const [vault, setVault] = useState(() => new MaskVault());
  // `draft` is the exact message under review; with an excerpt it is the whole excerpt message, and `question` is the
  // length of the question at its start (kept as the turn's prompt).
  const [review, setReview] = useState<{ draft: string; masks: Mask[]; past: Mask[][]; question: number; excerpt: Excerpt | null } | null>(null);
  // Features 02/03 "Circle anything" / "Send only this part": an approved excerpt replaces the whole document.
  const pickOn = ready && !freeMode && (chatInputOn('02', demo) || chatInputOn('03', demo));
  const [excerpt, setExcerpt] = useState<Excerpt | null>(null);
  const [picture, setPicture] = useState<DecodedImage | null>(null);
  const [pictureError, setPictureError] = useState('');
  const [editor, setEditor] = useState<{ source: EditorSource; purpose: ExcerptPurpose } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const pictureInput = useRef<HTMLInputElement>(null);
  // Feature 06 "Make this safe to post": a local export only. The picture is never sent and never changed.
  const safeOn = ready && chatInputOn('06', demo);
  const [safePost, setSafePost] = useState<DecodedImage | null>(null);
  const safeInput = useRef<HTMLInputElement>(null);
  // Feature 07 "Show me the proof": the document behind each turn, kept in this tab's memory only so citations can be
  // checked. It lives no longer than the attachment's chat: cleared on chat, key and mode change, or on request.
  const proofOn = ready && chatInputOn('07', demo);
  const [sources, setSources] = useState(() => new Map<string, ProofSource>());
  const privacyScope = useMemo(() => ({ chatId, key, demo }), [chatId, key, demo]);
  const [sourceScope, setSourceScope] = useState(privacyScope);
  if (sourceScope !== privacyScope) {
    setSourceScope(privacyScope);
    setVault(new MaskVault());
    setSources(new Map());
  }
  const [checking, setChecking] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const compliance = useCompanionCompliance(client, ready && updateOn('compliance', demo), turns.length > 0, chatId);
  const scan = useContentGuard();
  const streaming = turns.some((t) => t.status === 'streaming');
  // A character card is only a system prompt, so it works with any model, not just anonymo-rp.
  const character = characters.find((c) => c.id === characterId) ?? null;
  const greetings = character ? greetingsOf(character.card) : [];
  const greetingScope = `${chatId}:${character?.id ?? ''}`;
  const [chosenGreeting, setChosenGreeting] = useState<{ scope: string; index: number } | null>(null);
  const greeting = updateOn('lifeboat', demo) && chosenGreeting?.scope === greetingScope && greetings[chosenGreeting.index] ? chosenGreeting.index : 0;
  const pathname = usePathname();
  const destination = characterDestination('chat', character?.id);
  const vaultMemoryOn = ready && updateOn('vaultsync', demo);
  const memoryOn = vaultMemoryOn || (ready && updateOn('memory', demo));
  const router = useRouter();
  const walletRequest = ready && updateOn('walletreview', demo) && mightBeWalletRequest(text) && parseWalletRequest(text).ok;
  const memory = useChatMemory(memoryOn ? character : null, vaultMemoryOn);
  // Update "faces": the chosen character's faces from this device, and the Stage (the same thread shown as a scene).
  const facesOn = ready && updateOn('faces', demo);
  const faces = useFaces(demo, facesOn && character ? character.id : null);
  const [stage, setStage] = useState(false);
  // Update "share": share this chat as a sealed link (components/dashboard/share-chat.tsx).
  const shareOn = ready && updateOn('share', demo);

  // Update "history": finished turns are saved in this browser when the person has turned keeping on.
  const historyOn = ready && updateOn('history', demo);
  const keep = useDeviceStore(keepStore);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    if (historyOn && keep && !streaming && turns.length) void saveChat(demo, chatId, turns);
  }, [historyOn, keep, streaming, turns, demo, chatId]);

  const [lastCharacter, setLastCharacter] = useState(requestedCharacter);
  if (requestedCharacter !== lastCharacter) {
    setLastCharacter(requestedCharacter);
    if (requestedCharacter) setCharacterId(requestedCharacter);
    setSetupSheet(null);
  }
  const [draftChat, setDraftChat] = useState(chatId);
  if (draftChat !== chatId) {
    setDraftChat(chatId);
    setText('');
    setSelectedMode(null);
    setAudioCosts([]);
    setMenu(false);
    setSetupSheet(null);
    setWaitingDraft(false);
    setPaper(null);
    setGuardNote(null);
    tray.clear();
    setReview(null);
    setExcerpt(null);
    setPicture(null);
    setEditor(null);
    setSafePost(null);
  }
  useEffect(() => {
    if (!ready || !key || pathname !== '/dashboard/chat' || !composerHost) return;
    const frame = requestAnimationFrame(() => {
      const storage = tabStorage();
      const scope = { destination, demo };
      const draft = readSetupMessage(storage, scope);
      if (draft === null) return;
      clearSetupDraft(storage, scope);
      setText(draft.text);
      setSelectedMode(draft.mode);
      setWaitingDraft(true);
      setSetupSheet(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, key, pathname, composerHost, destination, demo]);
  useEffect(() => {
    if (!waitingDraft || !input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 220)}px`;
    input.current.focus({ preventScroll: true });
  }, [waitingDraft, composerHost]);
  useEffect(() => {
    if (setupSheet) setupAction.current?.focus({ preventScroll: true });
  }, [setupSheet, composerHost]);
  // A picture's decoded pixels are released as soon as it is replaced or the chat moves on.
  useEffect(() => () => picture?.bitmap.close(), [picture]);
  useEffect(() => () => { if (safePost && safePost !== picture) safePost.bitmap.close(); }, [safePost, picture]);
  const pendingScan = useRef(0);
  useEffect(() => { pendingScan.current++; }, [chatId]);
  useLayoutEffect(() => {
    if (modesOn) pendingScan.current++;
  }, [modesOn, mode, model, client, prefs, catalog, imageCatalog, paper, tray.photos]);
  useEffect(() => () => controller.current?.abort(), [key, demo]);
  useEffect(() => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (compact && threadHost) threadHost.scrollTo(0, threadHost.scrollHeight);
    else end.current?.scrollIntoView({ block: 'end', behavior: still ? 'auto' : 'smooth' });
  }, [turns.length, threadHost, compact]);
  const followReply = useRef(true);
  useEffect(() => {
    if (!compact || !threadHost) return;
    followReply.current = true;
    const onScroll = () => { followReply.current = threadHost.scrollHeight - threadHost.scrollTop - threadHost.clientHeight < 60; };
    threadHost.addEventListener('scroll', onScroll);
    return () => threadHost.removeEventListener('scroll', onScroll);
  }, [compact, threadHost]);
  useEffect(() => {
    if (compact && threadHost && followReply.current) threadHost.scrollTo(0, threadHost.scrollHeight);
  }, [turns, compact, threadHost]);

  const chooseModel = (id: string) => {
    setChatModel(id);
    if (modesOn) {
      if (id === 'anonymo-sealed') setSelectedMode(null);
      setMenu(false);
      setReview(null);
    }
  };

  function pickMode(next: ChatMode | null) {
    if (next && !availableModes.includes(next)) return;
    pendingScan.current++;
    setSelectedMode(next);
    setMenu(false);
    setGuardNote(null);
    setReview(null);
    setSetupSheet(null);
    input.current?.focus({ preventScroll: true });
  }

  function changeSettings<K extends ChatMode>(id: K, next: ModePrefs[K]) {
    pendingScan.current++;
    setReview(null);
    setModePrefs(demo, id, next);
  }

  function redo(turn: Turn, result: ModeResult) {
    if (streaming || !availableModes.includes(result.mode)) return;
    if (result.mode === 'talk') chooseModel(turn.model);
    changeSettings(result.mode, result.settings);
    setText(turn.prompt);
    setWaitingDraft(false);
    setAudioCosts([]);
    pickMode(result.mode);
  }

  const update = (id: string, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));

  function history(): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const t of turns) {
      if (t.status !== 'done' && t.status !== 'stopped') continue;
      if (t.modeResult?.mode === 'picture' || (t.modeResult?.mode === 'three' && !t.content)) continue;
      if (t.recap) {
        // Update "catchup": a recap turn starts the thread as context, not as something the person said.
        if (t.content) out.push(...recapContext(t.content));
        continue;
      }
      out.push({ role: 'user', content: t.sent ?? withPhotoNote(t.prompt, t.photoCount) });
      if (t.content) out.push({ role: 'assistant', content: t.content });
    }
    return out;
  }

  // Update "pricetag": what send() would send for this draft (keep in step with it), priced before it goes.
  function outgoing(prompt: string, content: string, includeVaultMemory = true): ChatMessage[] {
    let messages: ChatMessage[] = [...history(), { role: 'user', content }];
    if (character) {
      const built = buildCharacterMessages(character.card, messages, { greeting, memory: memoryFor(demo, character.id) });
      messages = built.messages.map((m) => ({ role: m.role as ChatMessage['role'], content: typeof m.content === 'string' ? m.content : '' }));
    }
    if (memoryOn && (character || vaultMemoryOn) && (includeVaultMemory || !vaultMemoryOn))
      messages = memory.addToPrompt(messages, memoryQuery(prompt));
    return messages;
  }
  function memoryQuery(prompt: string) {
    const recent = turns.filter((turn) => !turn.attachment && turn.status === 'done').slice(-2);
    return [prompt, ...recent.flatMap((turn) => [turn.prompt, turn.content.slice(-800)])];
  }

  // Price the same text context the request carries, including the profile.
  const aboutYouNote = useAboutYouNote(ready && updateOn('aboutyou', demo), demo);
  const priceOn = ready && !freeMode && updateOn('pricetag', demo);
  const priceDraft = !guestChat && (priceOn || modesOn) ? text.trim() : '';
  const priced = catalog?.find((m) => m.id === model) ?? null;
  const extraUsd = searchOn && webSearch && onlineModel(model, true) !== model ? WEB_SEARCH_PRICE_USD : undefined;
  const priceMessages = priceDraft || (priceOn && aboutYouNote && tray.photos.length)
    ? withAboutYou(outgoing(priceDraft, draftFor(priceDraft, excerpt)), aboutYouNote)
    : null;
  const modeEstimate = mode === 'picture' ? pictureEstimate(imageModel, settings.picture.n)
    : mode === 'three' ? (priceDraft ? threeEstimate(priceDraft, settings.three, comparisonModels, demo, aboutYouNote) : null)
      : undefined;
  const charges = useMemo(() => modesOn ? turns.flatMap(modeCharges) : turns, [modesOn, turns]);
  const price = usePriceTag({ on: priceOn, demo, chatId, model, priced, messages: priceMessages, turns: charges, extraUsd, modeEstimate });
  const [everyday, setEveryday] = useState<{ client: typeof client; access: EverydayAccess | null } | null>(null);
  const readEveryday = !!key && !demo && (updateOn('passes', false) || updateOn('stake', false));
  useEffect(() => {
    if (!readEveryday) return;
    const abort = new AbortController();
    const refresh = () => void client.everydayAccess(abort.signal).then(
      (access) => { if (!abort.signal.aborted) setEveryday({ client, access }); },
      () => { if (!abort.signal.aborted) setEveryday({ client, access: null }); },
    );
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => { abort.abort(); window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [client, readEveryday]);
  const rights = readEveryday && everyday?.client === client ? everyday.access : null;
  const passChat = !!rights?.hasPass && model === 'anonymo-1' && mode !== 'picture' && mode !== 'three' &&
    !extraUsd && !tray.photos.length && !excerpt?.image;
  const mayUseIncluded = key && (readEveryday && everyday?.client !== client ||
    passChat || !!rights?.hasPass && mode === 'picture' || !!rights?.availableCreditsUsd && mode !== 'three');
  const setupForBalance = guestChat ? (freeExhausted ? 'key' : null) : mayUseIncluded ? null : chatSetupStep(!!key, balance?.available_usd);
  const hasAttachment = !!(excerpt || paper || picture || tray.photos.length);
  const standalone = mode === 'picture' || mode === 'three';

  function showSetup(step: ChatSetupStep, source: string, withExcerpt: Excerpt | null, freeUpsell = guestChat && freeExhausted) {
    const saved = writeSetupDraft(tabStorage(), { destination, demo }, source, mode);
    setSetupSheet({ step, saved, freeUpsell, hasAttachment: !!(withExcerpt || paper || picture || tray.photos.length) });
  }

  function openSetup(source: string, withExcerpt: Excerpt | null, capture = false) {
    let step = setupForBalance;
    if (!step && !guestChat && balance && (!mayUseIncluded || capture)) {
      const draft = source.trim();
      const estimate = capture ? flatEstimate(perMinute) : mode === 'three' ?
        threeEstimate(draft, settings.three, comparisonModels, demo, aboutYouNote) : modeEstimate ??
        (priced ? estimateMessage({ model: priced, messages: withAboutYou(outgoing(draft, draftFor(draft, withExcerpt)), aboutYouNote), demo, extraUsd }) : null);
      step = chatSetupStep(!!key, balance.available_usd, estimate?.known ? estimate.typical : undefined);
    }
    if (!step) return false;
    showSetup(step, source, withExcerpt);
    return true;
  }

  const perMinute = parseUsdAtto(voice.transcription?.pricing.usd_per_started_minute);
  const transcriptionCost = recordingEstimate(perMinute, voice.transcription?.max_seconds ?? 0);
  const pendingVoiceCost = audioCosts.reduce<Atto>((sum, cost) => sum + (parseUsdAtto(cost) ?? 0n), 0n);
  const audioSpend = { charged: price.spend.charged + pendingVoiceCost };
  const voiceBusy = modesOn && price.limit !== null && voice.playing !== null;
  const voiceOverLimit = (estimate: ReturnType<typeof flatEstimate>) => checkLimit(price.limit, audioSpend, estimate).blocked;
  const offer = price.estimate ?? (modesOn && priceMessages ? estimateMessage({ model: priced, messages: priceMessages, demo, extraUsd }) : null);
  const estimateBlocked = price.blocked || (mode === 'talk' && offer !== null && voiceOverLimit(offer));
  const shownPrice = guestChat ? '' : mode === 'talk' && voice.transcription
    ? (perMinute === null ? '' : transcriptionRate(voice.transcription))
    : passChat ? 'Included with your Pass'
    : offer?.known
      ? mode === 'picture' ? spentLabel(offer.typical) : `${mode === 'three' ? 'up to' : 'about'} ${priceLabel(offer.typical, mode === 'three' ? 'up' : 'nearest')}`
      : '';

  function clearDraft() {
    clearSetupDraft(tabStorage(), { destination, demo });
    setText('');
    setAudioCosts([]);
    setWaitingDraft(false);
    setSetupSheet(null);
    setGuardNote(null);
    setPaper(null);
    tray.clear();
    setExcerpt(null);
    setPicture(null);
  }

  async function runMode(result: Extract<ModeResult, { mode: 'picture' | 'three' }>, prompt: string, message: string) {
    const id = crypto.randomUUID();
    const abort = new AbortController();
    controller.current = abort;
    const signals = compliance.takeSignals(prompt);
    const turn: Turn = {
      id, model: result.mode === 'picture' ? result.settings.model : result.settings.models[0],
      prompt, attachment: null, character: null, content: '', status: 'streaming', error: null,
      receiptId: null, receipt: null, council: null, councilMode: null, modeResult: result,
      ...signals,
    };
    setTurns((list) => [...list, turn]);
    const previousDraft = text;
    clearDraft();
    let needsFunds = false;
    let errorText: string | null = null;
    try {
      if (result.mode === 'picture') {
        const response = await client.generateImages({ ...result.settings, prompt: message }, abort.signal);
        const { cost_usd, receipt } = response.anonymo;
        const pictures = response.data.flatMap((image) => image.b64_json ? [`data:image/png;base64,${image.b64_json}`] : []);
        update(id, { modeResult: { ...result, images: pictures, costUsd: String(cost_usd), receipt } });
      } else {
        let round = result.round;
        const dispatch = (action: RoundAction) => {
          round = roundReducer(round, action);
          update(id, { modeResult: { ...result, round } });
        };
        dispatch({ type: 'ask', run: 1, question: message, models: result.settings.models, ...signals });
        const ask = (slot: SlotId, id: string, messages: ChatMessage[], maxTokens: number) => streamComparison({
          client, run: 1, slot, model: id, messages, maxTokens, demo, signal: abort.signal, refusalCatch,
          dispatch, waitForReceipt: true, onDelta: (value) => dispatch({ type: 'delta', run: 1, slot, text: value }),
        });
        await Promise.all(result.settings.models.map((id, slot) => ask(slot, id, [{ role: 'user', content: message }], ANSWER_MAX_TOKENS)));
        if (result.settings.merged && !abort.signal.aborted) {
          const usable = mergeable(round).filter(({ label }) => {
            const answer = round.columns[SLOTS.findIndex((slot) => slot === label)];
            return !!answer?.receipt;
          });
          if (usable.length >= 2 && canMerge(round)) {
            const messages = mergeRequest(message, usable);
            const check = await scan(messages.map(({ content }) => content).join('\n'));
            if (!abort.signal.aborted && !scanFailed(check) && !check.findings.some((finding) => finding.severity === 'block')) {
              dispatch({ type: 'merge', run: 1, model: MERGE_MODEL });
              await ask('merge', MERGE_MODEL, messages, MERGE_MAX_TOKENS);
            } else if (!abort.signal.aborted) {
              update(id, { modeResult: { ...result, round, mergeNote: 'The merge did not pass the content check.' } });
            }
          } else {
            update(id, { modeResult: { ...result, round, mergeNote: 'A merge needs at least two usable answers.' } });
          }
        }
        needsFunds = round.columns.some((answer) => answer.needsFunds) || !!round.merge?.needsFunds;
        if (round.merge?.status === 'done') update(id, { content: round.merge.content, receiptId: round.merge.receiptId, receipt: round.merge.receipt, sent: message });
      }
    } catch (error) {
      needsFunds = !abort.signal.aborted && isOutOfCredit(error);
      if (!abort.signal.aborted) errorText = result.mode === 'picture' ? imageError(error) : describeError(error);
    } finally {
      if (controller.current === abort) controller.current = null;
      update(id, { status: abort.signal.aborted ? 'stopped' : errorText ? 'error' : 'done', error: errorText });
      if (needsFunds && !abort.signal.aborted) {
        setText((draft) => draft || previousDraft);
        showSetup('funds', previousDraft, null);
      }
      refreshBalance();
    }
  }

  /**
   * Sends one turn. Call it only after the content check passed. `confirmed` is the digest of a reviewed preview:
   * when given, anything but that exact text is refused.
   */
  async function send(out: { prompt: string; message: string; excerpt: Excerpt | null }, confirmed?: string) {
    const prompt = out.prompt.trim();
    const message = out.message.trim();
    const sentExcerpt = out.excerpt;
    const photos = photosOn && !sentExcerpt ? tray.photos.map((p) => p.dataUrl) : [];
    if ((!message && !photos.length) || !modeReady || streaming || controller.current || (!key && !guestChat) || tray.busy || estimateBlocked || voiceBusy) return;
    if (confirmed !== undefined && payloadDigest(message, sentExcerpt?.image?.url) !== confirmed) return;
    if (standalone) {
      if (!message || hasAttachment) return;
      if (mode === 'picture' && imageModel) {
        if (message.length <= IMAGE_PROMPT_LIMIT) return runMode({ mode, settings: settings.picture, name: imageModel.name }, prompt, message);
        setGuardNote({ redacted: '', message: `Use ${IMAGE_PROMPT_LIMIT.toLocaleString()} characters or fewer for a picture.` });
      }
      if (mode === 'three') return runMode({ mode, settings: settings.three, round: EMPTY_ROUND }, prompt, message);
      return;
    }
    if (!guestChat && !modelReady) return;
    if ((photos.length || sentExcerpt?.image) && !support.ok) {
      setGuardNote({ redacted: '', message: photoHint(support) });
      return;
    }
    if (model !== 'anonymo-sealed') voice.prepare(mode === 'talk' ? settings.talk.aloud : undefined);
    setGuardNote(null);
    // An excerpt is a fresh payload built from what the person approved: the whole-document prompt is never used.
    const content = sentExcerpt ? excerptContent(message, character ? null : sentExcerpt.image) : message;
    // The chat path takes content parts; ChatMessage stays text-only for every other caller, so the one image message
    // is passed through as is (the client serialises the body unchanged).
    const messages = outgoing(prompt, content as string, false);
    const request = photos.length ? attachPhotos(messages, photos) : messages;
    const id = crypto.randomUUID();
    const turn: Turn = {
      id,
      model,
      prompt,
      attachment: sentExcerpt ? 'excerpt' : paper?.name ?? null,
      character: character?.card.data.name ?? null,
      content: '',
      status: 'streaming',
      error: null,
      receiptId: null,
      receipt: null,
      council: null,
      councilMode: model === 'anonymo-council' ? councilMode : null,
      ...compliance.takeSignals(prompt),
      ...(mode === 'talk' && voice.speech ? { modeResult: { mode, settings: settings.talk, speechModel: voice.speech.id, audioCosts } } : {}),
      ...(searchOn && webSearch && onlineModel(model, true) !== model ? { search: true } : {}),
      ...(photos.length ? { photos, photoCount: photos.length } : {}),
      ...(sentExcerpt ? { sent: message, excerpt: { page: sentExcerpt.page, image: !!sentExcerpt.image && !character } } : {}),
    };
    if (proofOn && sentExcerpt?.text) {
      const source = { name: 'Excerpt', pages: [{ number: sentExcerpt.page ?? 1, text: excerptBody(sentExcerpt) }] };
      setSources((map) => new Map(map).set(id, source));
    } else if (proofOn && paper && !sentExcerpt) {
      const source = { name: paper.name, pages: paper.pages.map((p) => ({ number: p.number, text: p.text })) };
      setSources((map) => new Map(map).set(id, source));
    }
    setTurns((list) => [...list, turn]);
    clearDraft();
    await run(turn, request, guestChat);
  }

  /** Streams one turn's reply into it, then settles its receipt and the balance. */
  async function run(turn: Turn, messages: (ChatMessage | ChatPhotoMessage)[], guest = false) {
    const { id, model } = turn;
    const listed = directModels.find(m => m.id === model);
    const plainChat = model === 'anonymo-1' || !!(listed && (publishedPpqChat(listed) || listed.ppq_uncensored === true));
    const councilMode = turn.councilMode ?? 'merge';
    const abort = new AbortController();
    controller.current = abort;
    let receiptId: string | null = null;
    let haveReceipt = false;
    let servedModel = model;
    let freeLeft: number | null = null;
    try {
      const loading = loadAboutYouForChat(demo);
      if (loading) await loading;
      if (vaultMemoryOn) await memory.prepareForPrompt();
      abort.signal.throwIfAborted();
      const recalled = vaultMemoryOn ? memory.addToPrompt(messages, memoryQuery(turn.prompt)) : messages;
      const context = withAboutYou(recalled, currentAboutYouNote(demo));
      const guestMessages = guest ? freeContext(context as ChatMessage[]) : null;
      const access = guest ? await free.authorize(abort.signal) : null;
      if (access) {
        servedModel = access.model;
        update(id, { model: servedModel });
      }
      const result = await client.chat(
        { model: access?.model ?? onlineModel(model, !!turn.search), messages: guestMessages ?? context, ...(!guest && plainChat && !turn.attachment && !turn.recap && !turn.search && !turn.photoCount ? { dashboard_chat: true as const } : {}) },
        {
          signal: abort.signal,
          ...(access ? { free: { ...access, onRemaining: (left: number) => { freeLeft = left; free.setRemaining(left); } } } : {}),
          headers: {
            ...(!guest && (isAnonymoModel(model) || isAutoModel(model)) ? { refusalCatch: refusalCatch ? 'on' : 'off' } : {}),
            ...(!guest && model === 'anonymo-council' ? { councilMode } : {}),
          },
          onDelta: (delta) => update(id, (t) => ({ content: t.content + delta })),
        },
      );
      receiptId = result.receiptId;
      haveReceipt = result.receipt !== null;
      update(id, { status: 'done', content: result.content, council: result.council, receiptId, receipt: result.receipt, answeredBy: result.model, autoClass: result.autoClass ?? null, ...(result.citations?.length ? { citations: result.citations } : {}) });
      const lastMessage = messages.at(-1);
      const memoryPrompt = vaultMemoryOn && lastMessage?.role === 'user' && typeof lastMessage.content === 'string'
        ? lastMessage.content : turn.prompt;
      if (!guest && !turn.recap && !turn.attachment && !abort.signal.aborted && (!vaultMemoryOn || !turn.photoCount))
        void memory.afterReply(id, model, memoryPrompt, result);
    } catch (error) {
      const stopped = abort.signal.aborted;
      const needsFunds = !stopped && isOutOfCredit(error);
      update(id, { status: stopped ? 'stopped' : 'error', error: stopped ? null : describeError(error), needsFunds });
      if ((needsFunds || (guest && !stopped && freeLeft === null)) && !turn.attachment && !turn.recap)
        setText(draft => draft || turn.prompt);
      if (guest && error instanceof AnonymoApiError) {
        if (error.code === 'free_daily_limit') {
          free.setRemaining(0);
          showSetup('key', turn.prompt, null, true);
        } else if (error.status === 404 || error.code === 'free_unavailable') {
          showSetup('key', turn.prompt, null, false);
        }
      }
      if (needsFunds && turn.modeResult?.mode === 'talk') showSetup('funds', turn.prompt, null);
    } finally {
      if (controller.current === abort) controller.current = null;
      if (!guest) refreshBalance();
      if (freeLeft === 0) showSetup('key', '', null, true);
    }
    if (receiptId) {
      rememberReceipt({ id: receiptId, model: servedModel, at: new Date().toISOString() });
      if (!haveReceipt)
        client.receipt(receiptId).then(
          (view) => update(id, { receipt: view.receipt }),
          () => undefined,
        );
    }
  }

  // Update "catchup": a long thread becomes a recap that starts a fresh chat (the old one stays saved, if kept).
  const catchupOn = ready && updateOn('catchup', demo);
  async function catchUp() {
    if (streaming || !key || !modelReady || !canRecap(turns)) return;
    let messages = recapRequest(history());
    if (character) {
      const built = buildCharacterMessages(character.card, messages, { greeting, memory: memoryFor(demo, character.id) });
      messages = built.messages.map((m) => ({ role: m.role as ChatMessage['role'], content: typeof m.content === 'string' ? m.content : '' }));
    }
    // The council answers by committee; a recap only needs one model, so it goes to anonymo-1.
    const recapModel = model === 'anonymo-council' ? 'anonymo-1' : model;
    const first = turns.find((t) => !t.recap)?.prompt ?? 'our chat';
    const title = first.replace(/\s+/g, ' ').trim().slice(0, 48);
    const turn: Turn = {
      id: crypto.randomUUID(),
      model: recapModel,
      prompt: `Recap of “${title}${first.length > 48 ? '…' : ''}”`,
      attachment: null,
      character: character?.card.data.name ?? null,
      content: '',
      status: 'streaming',
      error: null,
      receiptId: null,
      receipt: null,
      council: null,
      councilMode: null,
      recap: true,
    };
    openChat(null, [turn]);
    await run(turn, messages);
  }

  // The preview under review: exactly the text that will be sent, numbered from a copy of this chat's vault.
  const reviewed = (() => {
    if (!review) return null;
    const scratch = vault.clone();
    for (const t of turns) scratch.reserve(t.prompt);
    const segments = maskSegments(review.draft, review.masks, scratch);
    const outgoing = segmentsText(segments);
    const prompt = sanitizedSlice(segments, 0, review.question);
    return { segments, outgoing, prompt, digest: payloadDigest(outgoing, review.excerpt?.image?.url), scratch };
  })();
  const editReview = (masks: Mask[]) => setReview((r) => (r ? { ...r, masks, past: [...r.past, r.masks] } : r));

  /** The exact message for a question, with an approved excerpt when there is one. */
  function draftFor(question: string, ex: Excerpt | null) {
    return ex ? excerptMessage(question, ex) : paper ? paperPrompt(question, paper) : question;
  }

  /** Every send starts here (Enter, the Send button, "Send with it redacted", an excerpt): checked on this device first. */
  async function submit(source = text, withExcerpt = excerpt) {
    const prompt = source.trim();
    if (!ready || !modeReady || streaming || controller.current || tray.busy || voiceBusy) return;
    if (standalone && (hasAttachment || withExcerpt)) {
      setGuardNote({ redacted: '', message: 'Remove the attachment or return to Chat to send it.' });
      return;
    }
    if (mode === 'picture' && prompt.length > IMAGE_PROMPT_LIMIT) {
      setGuardNote({ redacted: '', message: `Use ${IMAGE_PROMPT_LIMIT.toLocaleString()} characters or fewer for a picture.` });
      return;
    }
    if (!prompt && !(photosOn && tray.photos.length && !withExcerpt)) return;
    if (openSetup(source, withExcerpt) || (!key && !guestChat)) return;
    if (!standalone && model !== 'anonymo-sealed') voice.prepare(mode === 'talk' ? settings.talk.aloud : undefined);
    const draft = standalone ? prompt : draftFor(prompt, withExcerpt);
    if (!draft) return send({ prompt, message: '', excerpt: null });
    if (review && reviewed && review.draft === draft) return confirmReview(reviewed.digest);
    const request = ++pendingScan.current;
    setChecking(true);
    const result = await scan(draft, { personal: maskOn });
    setChecking(false);
    if (request !== pendingScan.current) return;
    // A check that could not run sends nothing and offers no "redacted" text: the draft stays as it is.
    if (scanFailed(result)) {
      setGuardNote({ redacted: '', message: result.findings[0]?.message ?? 'The content check is unavailable. Nothing has been sent. Try again.' });
      return;
    }
    const blocking = result.findings.filter((f) => f.severity === 'block');
    if (blocking.length) {
      // A redacted excerpt message cannot be put back in the composer; the person edits the question or the excerpt.
      setGuardNote(withExcerpt || paper
        ? { redacted: '', message: `${blocking[0].message} Review your question and attachment before sending.` }
        : { redacted: result.redacted, message: blocking[0].message });
      return;
    }
    const masks = maskOn ? masksFromFindings(result.personal ?? [], vault.knownMasks(draft)) : [];
    if (masks.length) {
      setGuardNote(null);
      setReview({ draft, masks, past: [], question: prompt.length, excerpt: withExcerpt });
      return;
    }
    void send({ prompt, message: draft, excerpt: withExcerpt });
  }

  /** Sends the reviewed preview, only if it is still exactly what was shown and it passes the secret check again. */
  async function confirmReview(confirmed: string) {
    if (!review || !reviewed || streaming || (!key && !guestChat)) return;
    if (review.draft !== draftFor(text.trim(), excerpt) || reviewed.digest !== confirmed) {
      setReview(null);
      setGuardNote({ redacted: '', message: 'Your draft changed after the review. Review it again before sending.' });
      return;
    }
    if (openSetup(text, review.excerpt)) return;
    const { outgoing, scratch } = reviewed;
    const request = ++pendingScan.current;
    setChecking(true);
    const check = await scan(outgoing);
    setChecking(false);
    if (request !== pendingScan.current) return;
    if (scanFailed(check) || check.findings.some((f) => f.severity === 'block')) {
      setGuardNote({
        redacted: '',
        message: scanFailed(check) ? (check.findings[0]?.message ?? 'The content check is unavailable. Nothing has been sent.') : 'The masked message still contains secret-like material. Edit it before sending.',
      });
      return;
    }
    setVault(scratch);
    setReview(null);
    void send({ prompt: reviewed.prompt, message: outgoing, excerpt: review.excerpt }, confirmed);
  }

  const textarea = (
    <>
      <label className="sr-only" htmlFor="composer">
        Message
      </label>
      <textarea
        id="composer"
        ref={input}
        rows={1}
        value={text}
        placeholder={mode ? MODE_LABELS[mode].placeholder : character ? `Write to ${character.card.data.name}…` : 'Ask anything…'}
        disabled={!ready}
        onChange={(e) => {
          pendingScan.current++;
          setText(e.target.value);
          if (!e.target.value.trim()) {
            clearSetupDraft(tabStorage(), { destination, demo });
            setSetupSheet(null);
            setWaitingDraft(false);
          }
          setGuardNote(null);
          setReview(null);
          if (!modesOn) {
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
          }
        }}
        onDragOver={photosOn ? (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); } : undefined}
        onDrop={photosOn ? (e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          void tray.add(e.dataTransfer.files);
        } : undefined}
        onPaste={photosOn ? (e) => {
          if (!e.clipboardData.files.length) return;
          e.preventDefault();
          void tray.add(e.clipboardData.files);
        } : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && !e.shiftKey && hint && !e.nativeEvent.isComposing) {
            e.preventDefault();
            pickMode(hint.mode);
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
    </>
  );
  const modelPicker = guestChat ? null : (
    <ModelPicker value={model} onChange={chooseModel} live={liveModels} models={directModels}
          catalogError={catalogError} onRefresh={refreshCatalog} auto={autoOn} />
  );
  const composerTools = (
    <>
      <PaperTrail value={paper} onChange={(source) => { setPaper(source); setExcerpt(null); setReview(null); if (modesOn && source) setMenu(false); }} />
      {pickOn && paper && (
        <button type="button" className="tool" onClick={(e) => { opener.current = e.currentTarget; setEditor({ source: { kind: 'pdf', paper }, purpose: 'explain' }); }}>
          <Crop size={14} aria-hidden="true" /> Select part
        </button>
      )}
      {pickOn && (
        <>
          <input ref={pictureInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setPictureError('');
            decodeImage(file).then((image) => {
              setPicture(image);
              setExcerpt(null);
              setReview(null);
              setEditor({ source: { kind: 'image', image }, purpose: 'explain' });
            }, (error: unknown) => setPictureError(error instanceof Error ? error.message : 'This image could not be opened.'));
          }} />
          {picture ? (
            <span className="tool" style={{ gap: 4 }}>
              <button type="button" className="link-button" onClick={(e) => { opener.current = e.currentTarget; setEditor({ source: { kind: 'image', image: picture }, purpose: 'explain' }); }}>
                <ImageIcon size={14} aria-hidden="true" /> Select part of {picture.name}
              </button>
              <button type="button" className="link-button" aria-label="Remove image" onClick={() => { setPicture(null); setExcerpt(null); setReview(null); }}><X size={13} aria-hidden="true" /></button>
            </span>
          ) : (
            <button type="button" className="tool" onClick={(e) => { opener.current = e.currentTarget; pictureInput.current?.click(); }}>
              <ImageIcon size={14} aria-hidden="true" /> Image
            </button>
          )}
          {pictureError && <span role="alert" className="error-text">{pictureError}</span>}
        </>
      )}
      {safeOn && (
        <>
          <input ref={safeInput} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Picture to make safe to post" onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setPictureError('');
            decodeImage(file).then(setSafePost, (error: unknown) => setPictureError(error instanceof Error ? error.message : 'This image could not be opened.'));
          }} />
          <button type="button" className="tool" onClick={(e) => {
            opener.current = e.currentTarget;
            if (picture) setSafePost(picture);
            else safeInput.current?.click();
          }}>
            <ShieldCheck size={14} aria-hidden="true" /> Safe to post
          </button>
        </>
      )}
      {searchOn && <SearchToggle model={model} on={webSearch} onToggle={() => setWebSearch((w) => !w)} disabled={streaming} />}
      {photosOn && <PhotoButton tray={tray} support={support} disabled={streaming} />}
      {!freeMode && model === 'anonymo-council' && (
        <button
          type="button"
          className="tool"
          aria-pressed={councilMode === 'select'}
          title="merge: an aggregator merges the replies. select: a judge picks the best single reply (cheaper)."
          onClick={() => setCouncilMode((m) => (m === 'merge' ? 'select' : 'merge'))}
        >
          Council: {councilMode}
        </button>
      )}
      {characters.length > 0 && (
        <label className="tool">
          <Drama size={14} aria-hidden="true" />
          <select
            className="select"
            style={{ minHeight: 0, padding: 0, border: 0, background: 'transparent', width: 'auto', font: 'inherit', color: 'inherit' }}
            value={characterId ?? ''}
            onChange={(e) => { setCharacterId(e.target.value || null); setSetupSheet(null); }}
            aria-label="Character"
          >
            <option value="">No character</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.card.data.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {model !== 'anonymo-sealed' && <MoVoiceLink character={character?.id} className="tool" />}
      {shareOn && turns.length > 0 && <ShareChat turns={turns} disabled={streaming} />}
      {facesOn && character && <StageTools on={stage} onToggle={() => setStage((s) => !s)} character={character} faces={faces} />}
      {memoryOn && (character || vaultMemoryOn) && memory.memory?.enabled && (
        <button type="button" className="tool" aria-pressed={memory.extractionOn} disabled={memory.busy}
          title="Use a separate paid chat request to suggest facts after replies."
          onClick={memory.toggleExtraction}>Memory suggestions: {memory.extractionOn ? 'on' : 'off'}</button>
      )}
      {refusalTool && <button
        type="button"
        className="tool"
        aria-pressed={!refusalCatch}
        title="The refusal catch holds back the first tokens to catch a refusal and reroute it. Turning it off streams sooner."
        onClick={() => setRefusalCatch((r) => !r)}
      >
        Refusal catch: {refusalCatch ? 'on' : 'off'}
      </button>}
    </>
  );
  const safeEditor = (
    <>
      {safePost && (
        <SafePostEditor image={safePost} onClose={() => {
          setSafePost(null);
          setTimeout(() => (opener.current?.isConnected ? opener.current : input.current)?.focus(), 0);
        }} />
      )}
    </>
  );

  const activeTools: ActiveTool[] = [];
  if (paper) activeTools.push({ label: paper.name, remove: () => { setPaper(null); setExcerpt(null); setReview(null); } });
  if (picture) activeTools.push({ label: picture.name, remove: () => { setPicture(null); setExcerpt(null); setReview(null); } });
  if (photosOn && tray.photos.length) activeTools.push({ label: 'Photos', remove: tray.clear });
  if (searchOn && webSearch && onlineModel(model, true) !== model) activeTools.push({ label: standalone ? 'Chat web search' : 'Search the web', remove: () => setWebSearch(false) });
  // The chat model only applies to chat: a mode shows its own model in its settings row.
  if (!freeMode && !mode && model !== 'anonymo-1') activeTools.push({ label: `Model: ${model}`, remove: () => chooseModel('anonymo-1') });
  if (refusalTool && !refusalCatch) activeTools.push({ label: 'Refusal catch off', remove: () => setRefusalCatch(true) });
  if (!freeMode && !mode && model === 'anonymo-council' && councilMode === 'select') activeTools.push({ label: 'Council: select', remove: () => setCouncilMode('merge') });
  if (character) activeTools.push({ label: character.card.data.name, remove: () => { setCharacterId(null); setSetupSheet(null); } });
  if (voiceOn && voice.autoRead) activeTools.push({ label: 'Auto-read replies', remove: () => voice.toggleAutoRead(false) });
  if (stage && character) activeTools.push({ label: 'Stage', remove: () => setStage(false) });
  if (memoryOn && (character || vaultMemoryOn) && memory.extractionOn) activeTools.push({ label: 'Memory suggestions', remove: memory.toggleExtraction });
  if (price.limit !== null) activeTools.push({ label: `Limit ${usdText(price.limit)}`, remove: () => setChatLimit(demo, chatId, null) });

  const composerPrice = { ...price, estimate: null };
  const sendDisabled = !modeReady || checking || tray.busy || voiceBusy || (!text.trim() && (standalone || !photosOn || !tray.photos.length))
    || (!guestChat && !setupForBalance && ((!standalone && !modelReady) || estimateBlocked));
  const verb = mode === 'picture' || mode === 'three' ? MODE_LABELS[mode].verb : null;
  const sendButton = (
    <button type="button" className={verb ? 'mode-send mode-send-wide' : 'mode-send'} aria-label={verb ?? 'Send'}
      title={mode === 'talk' && offer?.known ? `Chat reply about ${priceLabel(offer.typical, 'nearest')}` : undefined}
      disabled={sendDisabled} onClick={() => void submit()}>
      {verb && <span>{verb}</span>}<ArrowUp size={17} aria-hidden="true" />
    </button>
  );
  const modeAction = streaming ? (
    <button type="button" className="mode-send" aria-label="Stop" onClick={() => controller.current?.abort()}>
      <Square size={14} fill="currentColor" aria-hidden="true" />
    </button>
  ) : mode === 'talk' && voice.transcription ? (
    <div className="mode-actions">
      {(text.trim() || (photosOn && tray.photos.length > 0)) && sendButton}
      {setupForBalance ? (
        <button type="button" className="mode-send mode-send-wide" onClick={() => openSetup(text, excerpt, true)}>Hold to talk</button>
      ) : (
        <VoiceMic key={chatId} mode model={voice.transcription} client={client} demo={demo}
          disabled={!modeReady || checking || voiceBusy}
          beforeRecord={() => {
            if (openSetup(text, excerpt, true)) return false;
            if (voiceOverLimit(flatEstimate(transcriptionCost))) {
              setGuardNote({ redacted: '', message: 'Recording could exceed this chat’s limit.' });
              return false;
            }
            voice.stop();
            return true;
          }}
          onCharge={refreshBalance} onFunds={() => showSetup('funds', text, excerpt)}
          onCost={(cost) => setAudioCosts((costs) => [...costs, cost])}
          onText={(transcript) => {
            pendingScan.current++;
            setText((draft) => draft ? `${draft.trimEnd()} ${transcript}` : transcript);
            setGuardNote(null);
            setReview(null);
            input.current?.focus();
          }} />
      )}
    </div>
  ) : sendButton;

  function leaveForSetup() {
    writeSetupDraft(tabStorage(), { destination, demo }, text, mode);
    setSetupSheet(null);
    setWaitingDraft(false);
    setReview(null);
    setPaper(null);
    setExcerpt(null);
    setPicture(null);
    tray.clear();
  }

  const composer = (
    <div className={modesOn ? 'dock-composer dock-composer-modes' : 'dock-composer'}>
      {freeMode && free.remaining !== null && (
        <output className="ai-notice">
          Free today: {free.remaining} left{free.solving ? ' · Checking this device…' : turns.length === 0 && !freeExhausted ? ' · Try it free. No account.' : ''}
        </output>
      )}
      {setupSheet ? (
        <section className="notice notice-action" aria-label="Set up chat">
          <output>
            <span>{setupSheet.freeUpsell
              ? `You’ve used your free messages today. Create a free key and add funds with a wallet${updateOn('codes', demo) ? ' or a code' : ''} to unlock every model.`
              : setupSheet.step === 'key'
              ? 'Your message is ready. To send it, make a free key and add a little balance. No account, no email, about a minute.'
              : 'Add a little balance to send this.'}</span>
            {setupSheet.hasAttachment && <><br /><small className="muted">Add your photos or attachments again after setup.</small></>}
            {!setupSheet.saved && <><br /><small className="muted">This browser couldn’t save your draft.</small></>}
          </output>
          <div className="row">
            <Link className="btn btn-primary btn-small" ref={setupAction} href={setupHref(setupSheet.step, destination)} onClick={leaveForSetup}>
              {setupSheet.step === 'key' ? 'Create a free key' : 'Add funds'}
            </Link>
            {updateOn('codes', demo) && (
              <Link className="btn btn-small" href={setupHref('redeem', destination)} onClick={leaveForSetup}>Have a code?</Link>
            )}
            <button type="button" className="btn btn-ghost btn-small" onClick={() => {
              setSetupSheet(null);
              input.current?.focus();
            }}>Not now</button>
          </div>
        </section>
      ) : waitingDraft && <output className="ai-notice">Your message is waiting. Press send.</output>}
      {guardNote && (
        <div className="notice notice-amber row" role="alert">
          <span style={{ flex: 1, minWidth: 200 }}>{guardNote.message}</span>
          {guardNote.redacted && (
            <button type="button" className="btn btn-small" onClick={() => {
              const redacted = guardNote.redacted;
              setText(redacted);
              setGuardNote(null);
              void submit(redacted);
            }}>
              Send with it redacted
            </button>
          )}
          <button type="button" className="btn btn-small btn-ghost" onClick={() => { setGuardNote(null); input.current?.focus(); }}>
            Edit
          </button>
        </div>
      )}
      {photosOn && <PhotoTrayView tray={tray} support={support} />}
      {review && reviewed && (
        <MaskReview
          segments={reviewed.segments}
          masks={review.masks}
          original={review.draft}
          busy={checking || streaming}
          canUndo={review.past.length > 0}
          onToggle={(index) => editReview(toggleMask(review.masks, index))}
          onMaskRange={(start, end) => editReview(addMask(review.draft, review.masks, start, end))}
          onUndo={() => setReview((r) => (r && r.past.length ? { ...r, masks: r.past[r.past.length - 1], past: r.past.slice(0, -1) } : r))}
          onSend={() => void confirmReview(reviewed.digest)}
          onEdit={() => { setReview(null); input.current?.focus(); }}
          extra={review.excerpt?.image && !character ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local data URL, never fetched
            <img className="editor-crop" src={review.excerpt.image.url} alt="Crop that will also be sent" />
          ) : null}
        />
      )}
      {walletRequest && !review && (
        // 08: a pasted wallet request is reviewed on its own page, on this device, and never sent to a model.
        <div className="notice row wallet-request-chip">
          <span style={{ flex: 1, minWidth: 200 }}>This looks like a wallet request. See what it allows before you sign it. It is not sent to a model.</span>
          <button type="button" className="btn btn-small" onClick={() => {
            try {
              sessionStorage.setItem(WALLET_REVIEW_DRAFT, text);
            } catch {
              return;
            }
            clearSetupDraft(tabStorage(), { destination, demo });
            setSetupSheet(null);
            setWaitingDraft(false);
            setText('');
            router.push('/dashboard/wallet-review');
          }}>Review this request</button>
        </div>
      )}
      {modesOn ? (
        <ChatModeComposer text={text} textarea={textarea} mode={mode} hint={hint} available={availableModes}
          menu={menu} setMenu={setMenu} price={shownPrice} onMode={pickMode} action={modeAction} active={activeTools}
          options={mode && <ChatModeSettings mode={mode} settings={settings} images={images} models={comparisonModels}
            voices={voice.speech?.voices ?? []} canMerge={mergeReady} onChange={changeSettings}
            studio={() => {
              giveStudioDraft(demo, text, settings.picture);
              router.push('/dashboard/images');
            }} />}
          tools={<>
            {modelPicker && <div className="mode-model-tool"><SlidersHorizontal size={15} aria-hidden="true" /> <span>Chat model</span>{modelPicker}</div>}
            {composerTools}
            {voiceOn && <VoiceSettings sealed={model === 'anonymo-sealed'} />}
            {priceOn && <details className="mode-price-tools"><summary>Chat spending</summary><PriceTag {...composerPrice} /></details>}
            <span className="mode-menu-note">{historyOn && keep ? 'Chat history is saved on this device.' : 'Chat history is off on this device.'}</span>
          </>} />
      ) : (
        <form
          className="dock-input"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {textarea}
          {modelPicker}
          {voiceOn && !guestChat && voice.transcription && model !== 'anonymo-sealed' && (
            <VoiceMic key={chatId} model={voice.transcription} client={client} demo={demo} disabled={streaming}
              beforeRecord={voice.stop} onCharge={refreshBalance} onText={(transcript) => {
                setText((draft) => draft ? `${draft.trimEnd()} ${transcript}` : transcript);
                setGuardNote(null);
                setReview(null);
                input.current?.focus();
              }} />
          )}
          {streaming ? (
            <button type="button" className="send send-stop" aria-label="Stop" onClick={() => controller.current?.abort()}>
              <Square size={14} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="send" aria-label="Send" disabled={!ready || (!text.trim() && !(photosOn && tray.photos.length)) || (photosOn && tray.busy) || (!guestChat && !setupForBalance && (!modelReady || price.blocked))}>
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          )}
        </form>
      )}
      {priceOn && !modesOn && <PriceTag {...price} />}
      {modesOn && estimateBlocked && <output className="notice notice-amber">This message could exceed this chat’s limit. Open Chat spending to change the limit.</output>}
      {mode && !modeReady && <output className="mode-detail">{MODE_LABELS[mode].label} is unavailable right now.</output>}
      {mode === 'talk' && settings.talk.aloud && voice.speech && parseUsdAtto(voice.speech.pricing.usd_per_1k_chars) !== null && (
        <output className="mode-detail">Read replies · {speechRate(voice.speech)}</output>
      )}
      {key && !modelReady && !standalone && <output className="notice">{!catalog && !catalogError ? 'Checking your selected model…' : 'Your selected model is unavailable. Choose another model to send.'}</output>}
      {memoryOn && (character || vaultMemoryOn) && <MemorySuggestions {...memory} />}
      {excerpt && (
        <fieldset className="excerpt-chip" aria-label="Approved excerpt" style={{ minInlineSize: 0, margin: 0 }}>
          <span className="chip"><Crop size={13} aria-hidden="true" /> {excerpt.image ? 'Cropped image only' : 'Excerpt only'}{excerpt.page ? ` · p. ${excerpt.page}` : ''}</span>
          <span className="excerpt-chip-text">{excerptBody(excerpt) || 'Image only'}</span>
          <button type="button" className="link-button" onClick={() => { pendingScan.current++; setExcerpt(null); setReview(null); }}>Remove</button>
          <span className="faint" style={{ flexBasis: '100%' }}>Only this excerpt is sent{paper ? '. The rest of the PDF stays on this device.' : '.'}</span>
        </fieldset>
      )}
      {editor && (
        <AttachmentEditor
          source={editor.source}
          initialPurpose={editor.purpose}
          imageModel={visionModel && !character}
          initialQuestion={text.trim() || DEFAULT_QUESTION[editor.purpose]}
          onCancel={() => {
            setEditor(null);
            // The page behind a modal sheet is inert, so focus goes back once the sheet is gone.
            setTimeout(() => (opener.current?.isConnected ? opener.current : input.current)?.focus(), 0);
          }}
          onUse={(chosen, question) => {
            setEditor(null);
            setExcerpt(chosen);
            setText(question);
            setGuardNote(null);
            setReview(null);
            setTimeout(() => input.current?.focus(), 0);
            void submit(question, chosen);
          }}
        />
      )}
      {safeEditor}
      {!modesOn && <div className="dock-tools">{composerTools}</div>}
      {!modesOn && voiceOn && <VoiceSettings sealed={model === 'anonymo-sealed'} />}
      {!modesOn && <div className="dock-meta">
        <span>Enter to send · Shift+Enter for a new line</span>
        <span>{historyOn && keep ? 'Chat history is saved on this device.' : 'Chat history is off on this device.'}</span>
      </div>}
    </div>
  );

  // What the thread shows with a turn besides its answer. The Stage shows the same, so neither notice can be missed there.
  const notices = (turn: Turn) => (
    <>
      {turn.aiReminder && (
        <p className="ai-reminder" role="note">
          {AI_REMINDER}
        </p>
      )}
      {turn.crisis && <CrisisNotice />}
    </>
  );

  const installAfter = BUILT_WITH.has('app') && !compact
    ? turns.find((turn) => turn.status === 'done' && turn.content.trim())?.id
    : undefined;

  function turnAnswer(turn: Turn) {
    const proof = proofOn ? {
      source: sources.get(turn.id) ?? null,
      onForget: () => setSources((map) => {
        const next = new Map(map);
        next.delete(turn.id);
        return next;
      }),
    } : null;
    const result = turn.modeResult;
    if (result) return <ChatModeTurn turn={{ ...turn, modeResult: result }} characterId={character?.id} proof={proof}
      redo={!streaming && availableModes.includes(result.mode) ? () => redo(turn, result) : undefined} />;
    return <AnswerCard turn={turn} characterId={character?.id} proof={proof} />;
  }

  const thread = compliance.restricted ? (
    <RegionPage mode={compliance.restricted} client={client} onVerified={compliance.refresh} />
  ) : (
    <>
      {compliance.disclosure && <CompanionDisclosure />}
      {(historyOn || catchupOn) && (
        <>
          <ChatBar
            compact={compact}
            history={historyOn}
            onOpen={() => setHistoryOpen(true)}
            catchUp={catchupOn ? { onCatchUp: () => void catchUp(), busy: streaming, ready: !!key && canRecap(turns), suggest: suggestRecap(turns), tokens: threadTokens(turns) } : null}
          />
          {historyOn && <ChatHistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />}
        </>
      )}
      {facesOn && stage && character ? (
        <Stage character={character} faces={faces} turns={turns} streaming={streaming} notices={notices} renderAnswer={modesOn ? turnAnswer : undefined} onLog={() => setStage(false)} />
      ) : compact && !turns.length ? (
        <div className="mascot-welcome">
          {hasFace(faces) ? <FaceAvatar faces={faces} /> : <MascotSprite mood="greet" />}
          <h3>{character?.card.data.name ?? 'What’s on your mind?'}</h3>
          <p>Start a conversation here.</p>
        </div>
      ) : turns.length === 0 ? (
        <section className="empty chat-col">
          <div className="empty-hero">
            {hasFace(faces) ? <FaceAvatar faces={faces} /> : <Photo src="/mascot/avatar.jpg" alt="" width={256} height={256} />}
            <div>
              <h1>{character ? character.card.data.name : 'Start a conversation'}</h1>
              <p className="muted">
                {character
                  ? modesOn ? 'This AI character is saved on this device. Use + to switch characters.' : 'This AI character is saved on this device. Switch characters below the message box.'
                  : 'Write a message or start with one of these ideas.'}
              </p>
            </div>
          </div>
          {!character && (
            <div className="starters">
              {(availableModes.length ? [STARTERS[0], ...availableModes.map((id) => MODE_STARTERS[id])] : STARTERS).map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => {
                    setText(starter);
                    setReview(null);
                    input.current?.focus();
                  }}
                >
                  {starter}
                </button>
              ))}
            </div>
          )}
          {updateOn('lifeboat', demo) && greetings.length > 1 && (
            <label className="row">
              Greeting
              <select className="input" value={greeting} onChange={(event) => setChosenGreeting({ scope: greetingScope, index: Number(event.target.value) })}>
                {greetings.map((_, index) => <option key={index} value={index}>{index === 0 ? 'First greeting' : `Alternate greeting ${index}`}</option>)}
              </select>
            </label>
          )}
          {character && greetings[greeting] && (
            <div className="answer">
              <div className="answer-head">{character.card.data.name}</div>
              <p className="answer-body">{greetings[greeting]}</p>
            </div>
          )}
        </section>
      ) : (
        <div className="thread chat-col" aria-live="polite" aria-busy={streaming}>
          <h1 className="sr-only">Chat</h1>
          {turns.map((turn) => (
            <article key={turn.id} className="turn">
              {turn.aiReminder && (
                <p className="ai-reminder" role="note">
                  {AI_REMINDER}
                </p>
              )}
              {turn.prompt && (maskOn ? <MaskedPrompt text={turn.prompt} vault={vault} /> : <p className="prompt">{turn.prompt}</p>)}
              {photosOn && <TurnPhotos photos={turn.photos} count={turn.photoCount} />}
              {turn.recap && (
                <p className="recap-note" role="note">
                  Caught up: this chat starts from a recap of the last one, so replies stay sharp and cheaper.
                </p>
              )}
              {(turn.attachment || turn.character) && (
                <div className="prompt-meta">
                  {turn.attachment && (turn.excerpt || turn.attachment === 'excerpt'
                    ? <span className="chip"><Crop size={12} aria-hidden="true" /> {turn.excerpt?.image ? 'Cropped image' : 'Excerpt only'}{turn.excerpt?.page ? ` · p. ${turn.excerpt.page}` : ''}</span>
                    : <span className="chip">PDF · {turn.attachment}</span>)}
                  {turn.character && <span className="chip">as {turn.character}</span>}
                </div>
              )}
              {turn.crisis && <CrisisNotice />}
              <div className="ai-row">
                <TurnFace faces={character && turn.character === character.card.data.name ? faces : null} turn={turn} />
                {turnAnswer(turn)}
              </div>
              {turn.id === installAfter && <InstallAppCard />}
            </article>
          ))}
          <div ref={end} />
        </div>
      )}
    </>
  );
  return <ChatVoiceContext.Provider value={voiceOn ? voice : null}>{threadHost && createPortal(thread, threadHost)}{composerHost && !compliance.restricted && createPortal(composer, composerHost)}</ChatVoiceContext.Provider>;
}
