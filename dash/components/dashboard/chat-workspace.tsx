'use client';

import { characterDestination, setupHref } from '@/lib/anonymo/setup-return';

import { MascotSprite } from '../mascot-sprite';
import { Photo } from '@/components/photo';
import Link from 'next/link';
import { ArrowUp, Crop, Drama, ImageIcon, ShieldCheck, Square, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { mightBeWalletRequest, parseWalletRequest, WALLET_REVIEW_DRAFT } from '@/lib/anonymo/wallet-request';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { describeError, isOutOfCredit } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { chatModels, isAnonymoModel, publishedPpqChat } from '@/lib/anonymo/chat-models';
import { chatModelStore, setChatModel } from '@/lib/anonymo/prefs';
import type { ChatMessage, ChatPhotoMessage } from '@/lib/anonymo/types';
import { attachPhotos, photoHint, photoSupport, withPhotoNote } from '@/lib/anonymo/photos';
import { paperPrompt, type PaperSource } from '@/lib/paper-trail';
import { AI_REMINDER, CRISIS_LINES, mentionsSelfHarm, reminderDue } from '@/lib/anonymo/safety';
import { keepStore, saveChat } from '@/lib/anonymo/history';
import { canRecap, recapContext, recapRequest, suggestRecap, threadTokens } from '@/lib/anonymo/catchup';
import { updateOn } from '@/lib/anonymo/updates';
import { PriceTag, usePriceTag } from './price-tag';
import { isAutoModel } from '@/lib/anonymo/auto';
import { onlineModel, WEB_SEARCH_PRICE_USD } from '@/lib/anonymo/search';
import { SearchToggle } from './web-sources';
import { chatInputOn } from '@/lib/anonymo/chat-inputs';
import { MaskVault, addMask, maskSegments, masksFromFindings, payloadDigest, sanitizedSlice, segmentsText, toggleMask, type Mask } from '@/lib/anonymo/masking';

const STARTERS = [
  'Give me three ideas for a short mystery story.',
  'Help me turn a rough idea into a plan.',
];

export function ChatWorkspace({ compact, threadHost, composerHost }: {
  compact: boolean;
  threadHost: HTMLDivElement | null;
  composerHost: HTMLDivElement | null;
}) {
  const { ready, demo, key, client, turns, setTurns, chatId, openChat, rememberReceipt, refreshBalance, liveModels, catalog, catalogError, refreshCatalog } = useAnonymo();
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
  const searchOn = ready && updateOn('search', demo);
  const [webSearch, setWebSearch] = useState(false);
  const [text, setText] = useState(() => {
    const last = turns.at(-1);
    return last?.needsFunds && !last.attachment && !last.recap ? last.prompt : '';
  });
  const voiceOn = ready && updateOn('talk', demo);
  const voice = useChatVoice({ enabled: voiceOn && !!key, client, chatId, turns, refreshBalance });
  const [paper, setPaper] = useState<PaperSource | null>(null);
  // Update "photos": only a model that lists image input gets them; the tray lives in this tab's memory only.
  const photosOn = ready && updateOn('photos', demo);
  const support = useMemo(() => photoSupport(model, directModels), [model, directModels]);
  const tray = usePhotos(support);
  const characters = useDeviceStore(charactersStore);
  const [characterId, setCharacterId] = useState<string | null>(requestedCharacter);
  // `redacted` is empty when there is no safe redacted version to offer (the check itself failed).
  const [guardNote, setGuardNote] = useState<{ redacted: string; message: string } | null>(null);
  // Feature 01 "Mask my details": the draft under review, its masks and an undo stack. The vault maps this chat's
  // placeholders back to the original values, in memory only.
  const maskOn = ready && chatInputOn('01', demo);
  const vault = useRef(new MaskVault());
  // `draft` is the exact message under review; with an excerpt it is the whole excerpt message, and `question` is the
  // length of the question at its start (kept as the turn's prompt).
  const [review, setReview] = useState<{ draft: string; masks: Mask[]; past: Mask[][]; question: number; excerpt: Excerpt | null } | null>(null);
  // Features 02/03 "Circle anything" / "Send only this part": an approved excerpt replaces the whole document.
  const pickOn = ready && (chatInputOn('02', demo) || chatInputOn('03', demo));
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
  const sources = useRef(new Map<string, ProofSource>());
  const [, setSourcesVersion] = useState(0);
  const [checking, setChecking] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  // Track the last in-thread reminder independently of the AI label on the model picker.
  const noticedAt = useRef(Date.now());
  const scan = useContentGuard();
  const streaming = turns.some((t) => t.status === 'streaming');
  // A character card is only a system prompt, so it works with any model, not just anonymo-rp.
  const character = characters.find((c) => c.id === characterId) ?? null;
  const memoryOn = ready && updateOn('memory', demo);
  const router = useRouter();
  const walletRequest = ready && updateOn('walletreview', demo) && mightBeWalletRequest(text) && parseWalletRequest(text).ok;
  const memory = useChatMemory(memoryOn ? character : null);
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
    if (historyOn && keep && !streaming && turns.length) saveChat(demo, chatId, turns);
  }, [historyOn, keep, streaming, turns, demo, chatId]);

  const [lastCharacter, setLastCharacter] = useState(requestedCharacter);
  if (requestedCharacter !== lastCharacter) {
    setLastCharacter(requestedCharacter);
    if (requestedCharacter) setCharacterId(requestedCharacter);
  }
  const [draftChat, setDraftChat] = useState(chatId);
  if (draftChat !== chatId) {
    setDraftChat(chatId);
    setText('');
    setPaper(null);
    setGuardNote(null);
    tray.clear();
    setReview(null);
    setExcerpt(null);
    setPicture(null);
    setEditor(null);
    setSafePost(null);
  }
  // A picture's decoded pixels are released as soon as it is replaced or the chat moves on.
  useEffect(() => () => picture?.bitmap.close(), [picture]);
  useEffect(() => () => { if (safePost && safePost !== picture) safePost.bitmap.close(); }, [safePost, picture]);
  const pendingScan = useRef(0);
  useEffect(() => { pendingScan.current++; }, [chatId]);
  // Original values never outlive the chat, the key or the mode they were typed in.
  useEffect(() => {
    const restore = vault.current;
    const kept = sources.current;
    return () => {
      restore.clear();
      kept.clear();
    };
  }, [chatId, key, demo]);
  useEffect(() => () => controller.current?.abort(), [key, demo]);
  useEffect(() => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (compact && threadHost) threadHost.scrollTop = threadHost.scrollHeight;
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
    if (compact && threadHost && followReply.current) threadHost.scrollTop = threadHost.scrollHeight;
  }, [turns, compact, threadHost]);

  const chooseModel = (id: string) => setChatModel(id);

  const update = (id: string, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));

  function history(): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const t of turns) {
      if (t.status !== 'done' && t.status !== 'stopped') continue;
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
  function outgoing(prompt: string): ChatMessage[] {
    let messages: ChatMessage[] = [...history(), { role: 'user', content: excerpt ? excerptMessage(prompt, excerpt) : paper ? paperPrompt(prompt, paper) : prompt }];
    if (character) {
      const built = buildCharacterMessages(character.card, messages, { memory: memoryFor(demo, character.id) });
      messages = built.messages.map((m) => ({ role: m.role as ChatMessage['role'], content: typeof m.content === 'string' ? m.content : '' }));
      if (memoryOn) {
        const recent = turns.filter((turn) => !turn.attachment && turn.status === 'done').slice(-2);
        messages = memory.addToPrompt(messages, [prompt, ...recent.flatMap((turn) => [turn.prompt, turn.content.slice(-800)])]);
      }
    }
    return messages;
  }
  const priceOn = ready && updateOn('pricetag', demo);
  const priceDraft = priceOn ? text.trim() : '';
  const price = usePriceTag({ on: priceOn, demo, chatId, model, priced: catalog?.find((m) => m.id === model) ?? null, messages: priceDraft ? outgoing(priceDraft) : null, turns, extraUsd: searchOn && webSearch && onlineModel(model, true) !== model ? WEB_SEARCH_PRICE_USD : undefined });

  /**
   * Sends one turn. Call it only after the content check passed. `confirmed` is the digest of a reviewed preview:
   * when given, anything but that exact text is refused.
   */
  async function send(out: { prompt: string; message: string; excerpt: Excerpt | null }, confirmed?: string) {
    const prompt = out.prompt.trim();
    const message = out.message.trim();
    const sentExcerpt = out.excerpt;
    const photos = photosOn && !sentExcerpt ? tray.photos.map((p) => p.dataUrl) : [];
    if ((!message && !photos.length) || streaming || controller.current || !key || !modelReady || tray.busy || price.blocked) return;
    if ((photos.length || sentExcerpt?.image) && !support.ok) {
      setGuardNote({ redacted: '', message: photoHint(support) });
      return;
    }
    if (confirmed !== undefined && payloadDigest(message, sentExcerpt?.image?.url) !== confirmed) return;
    if (model !== 'anonymo-sealed') voice.prepare();
    setGuardNote(null);
    // An excerpt is a fresh payload built from what the person approved: the whole-document prompt is never used.
    const content = sentExcerpt ? excerptContent(message, character ? null : sentExcerpt.image) : message;
    // The chat path takes content parts; ChatMessage stays text-only for every other caller, so the one image message
    // is passed through as is (the client serialises the body unchanged).
    let messages: ChatMessage[] = [...history(), { role: 'user', content: content as string }];
    if (character) {
      const built = buildCharacterMessages(character.card, messages, { memory: memoryFor(demo, character.id) });
      messages = built.messages.map((m) => ({ role: m.role as ChatMessage['role'], content: typeof m.content === 'string' ? m.content : '' }));
      if (memoryOn) {
        const recent = turns.filter((turn) => !turn.attachment && turn.status === 'done').slice(-2);
        messages = memory.addToPrompt(messages, [prompt, ...recent.flatMap((turn) => [turn.prompt, turn.content.slice(-800)])]);
      }
    }
    const request = photos.length ? attachPhotos(messages, photos) : messages;
    const id = crypto.randomUUID();
    const aiReminder = reminderDue(noticedAt.current);
    if (aiReminder) noticedAt.current = Date.now();
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
      aiReminder,
      crisis: mentionsSelfHarm(prompt),
      ...(searchOn && webSearch && onlineModel(model, true) !== model ? { search: true } : {}),
      ...(photos.length ? { photos, photoCount: photos.length } : {}),
      ...(sentExcerpt ? { sent: message, excerpt: { page: sentExcerpt.page, image: !!sentExcerpt.image && !character } } : {}),
    };
    if (proofOn && sentExcerpt?.text) {
      sources.current.set(id, { name: 'Excerpt', pages: [{ number: sentExcerpt.page ?? 1, text: excerptBody(sentExcerpt) }] });
    } else if (proofOn && paper && !sentExcerpt) {
      sources.current.set(id, { name: paper.name, pages: paper.pages.map((p) => ({ number: p.number, text: p.text })) });
    }
    setTurns((list) => [...list, turn]);
    setText('');
    setPaper(null);
    tray.clear();
    setExcerpt(null);
    setPicture(null);
    await run(turn, request);
  }

  /** Streams one turn's reply into it, then settles its receipt and the balance. */
  async function run(turn: Turn, messages: (ChatMessage | ChatPhotoMessage)[]) {
    const { id, model } = turn;
    const listed = directModels.find(m => m.id === model);
    const plainChat = model === 'anonymo-1' || !!(listed && (publishedPpqChat(listed) || listed.ppq_uncensored === true));
    const councilMode = turn.councilMode ?? 'merge';
    const abort = new AbortController();
    controller.current = abort;
    let receiptId: string | null = null;
    let haveReceipt = false;
    try {
      const result = await client.chat(
        { model: onlineModel(model, !!turn.search), messages, ...(plainChat && !turn.attachment && !turn.recap && !turn.search && !turn.photoCount ? { dashboard_chat: true as const } : {}) },
        {
          signal: abort.signal,
          headers: {
            ...(isAnonymoModel(model) || isAutoModel(model) ? { refusalCatch: refusalCatch ? 'on' : 'off' } : {}),
            ...(model === 'anonymo-council' ? { councilMode } : {}),
          },
          onDelta: (delta) => update(id, (t) => ({ content: t.content + delta })),
        },
      );
      receiptId = result.receiptId;
      haveReceipt = result.receipt !== null;
      update(id, { status: 'done', content: result.content, council: result.council, receiptId, receipt: result.receipt, answeredBy: result.model, autoClass: result.autoClass ?? null, ...(result.citations?.length ? { citations: result.citations } : {}) });
      if (!turn.recap && !turn.attachment && !abort.signal.aborted)
        void memory.afterReply(id, model, turn.prompt, result);
    } catch (error) {
      const stopped = abort.signal.aborted;
      const needsFunds = !stopped && isOutOfCredit(error);
      update(id, { status: stopped ? 'stopped' : 'error', error: stopped ? null : describeError(error), needsFunds });
      if (needsFunds && !turn.attachment && !turn.recap) setText(draft => draft || turn.prompt);
    } finally {
      if (controller.current === abort) controller.current = null;
      refreshBalance();
    }
    if (receiptId) {
      rememberReceipt({ id: receiptId, model, at: new Date().toISOString() });
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
      const built = buildCharacterMessages(character.card, messages, { memory: memoryFor(demo, character.id) });
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
    const scratch = vault.current.clone();
    for (const t of turns) scratch.reserve(t.prompt);
    const segments = maskSegments(review.draft, review.masks, scratch);
    const outgoing = segmentsText(segments);
    const prompt = sanitizedSlice(segments, 0, review.question);
    return { segments, outgoing, prompt, digest: payloadDigest(outgoing, review.excerpt?.image?.url), scratch };
  })();
  const editReview = (masks: Mask[]) => setReview((r) => (r ? { ...r, masks, past: [...r.past, r.masks] } : r));

  /** The exact message for a question, with an approved excerpt when there is one. */
  const draftFor = (question: string, ex: Excerpt | null) => (ex ? excerptMessage(question, ex) : paper ? paperPrompt(question, paper) : question);

  /** Every send starts here (Enter, the Send button, "Send with it redacted", an excerpt): checked on this device first. */
  async function submit(source = text, withExcerpt = excerpt) {
    const prompt = source.trim();
    if (streaming || !key) return;
    if (!prompt && !(photosOn && tray.photos.length && !withExcerpt)) return;
    if (model !== 'anonymo-sealed') voice.prepare();
    const draft = draftFor(prompt, withExcerpt);
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
    const masks = maskOn ? masksFromFindings(result.personal ?? [], vault.current.knownMasks(draft)) : [];
    if (masks.length) {
      setGuardNote(null);
      setReview({ draft, masks, past: [], question: prompt.length, excerpt: withExcerpt });
      return;
    }
    void send({ prompt, message: draft, excerpt: withExcerpt });
  }

  /** Sends the reviewed preview, only if it is still exactly what was shown and it passes the secret check again. */
  async function confirmReview(confirmed: string) {
    if (!review || !reviewed || streaming || !key) return;
    if (review.draft !== draftFor(text.trim(), excerpt) || reviewed.digest !== confirmed) {
      setReview(null);
      setGuardNote({ redacted: '', message: 'Your draft changed after the review. Review it again before sending.' });
      return;
    }
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
    vault.current.adopt(scratch);
    setReview(null);
    void send({ prompt: reviewed.prompt, message: outgoing, excerpt: review.excerpt }, confirmed);
  }

  const composer = (
    <div className="dock-composer">
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
            setText('');
            router.push('/dashboard/wallet-review');
          }}>Review this request</button>
        </div>
      )}
      <form
        className="dock-input"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="composer">
          Message
        </label>
        <textarea
          id="composer"
          ref={input}
          rows={1}
          value={text}
          placeholder={key ? (character ? `Write to ${character.card.data.name}…` : 'Ask anything…') : 'Create a key to start chatting'}
          disabled={!ready || !key}
          onChange={(e) => {
            pendingScan.current++;
            setText(e.target.value);
            setGuardNote(null);
            setReview(null);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
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
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <ModelPicker value={model} onChange={chooseModel} live={liveModels} models={directModels}
          catalogError={catalogError} onRefresh={refreshCatalog} auto={autoOn} />
        {voiceOn && voice.transcription && model !== 'anonymo-sealed' && (
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
          <button type="submit" className="send" aria-label="Send" disabled={!key || !modelReady || (!text.trim() && !(photosOn && tray.photos.length)) || (photosOn && tray.busy) || price.blocked}>
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        )}
      </form>
      {priceOn && <PriceTag {...price} />}
      {!modelReady && <p className="notice" role="status">{!catalog && !catalogError ? 'Checking your selected model…' : 'Your selected model is unavailable. Choose another model to send.'}</p>}
      {memoryOn && character && <MemorySuggestions {...memory} />}
      {excerpt && (
        <div className="excerpt-chip" role="group" aria-label="Approved excerpt">
          <span className="chip"><Crop size={13} aria-hidden="true" /> {excerpt.image ? 'Cropped image only' : 'Excerpt only'}{excerpt.page ? ` · p. ${excerpt.page}` : ''}</span>
          <span className="excerpt-chip-text">{excerptBody(excerpt) || 'Image only'}</span>
          <button type="button" className="link-button" onClick={() => { setExcerpt(null); setReview(null); }}>Remove</button>
          <span className="faint" style={{ flexBasis: '100%' }}>Only this excerpt is sent{paper ? '. The rest of the PDF stays on this device.' : '.'}</span>
        </div>
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
      <div className="dock-tools">
        <PaperTrail value={paper} onChange={(source) => { setPaper(source); setExcerpt(null); setReview(null); }} />
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
        {safePost && (
          <SafePostEditor image={safePost} onClose={() => {
            setSafePost(null);
            setTimeout(() => (opener.current?.isConnected ? opener.current : input.current)?.focus(), 0);
          }} />
        )}
        {searchOn && <SearchToggle model={model} on={webSearch} onToggle={() => setWebSearch((w) => !w)} disabled={streaming} />}
        {photosOn && <PhotoButton tray={tray} support={support} disabled={streaming} />}
        {model === 'anonymo-council' && (
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
              onChange={(e) => setCharacterId(e.target.value || null)}
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
        {shareOn && turns.length > 0 && <ShareChat turns={turns} disabled={streaming} />}
        {facesOn && character && <StageTools on={stage} onToggle={() => setStage((s) => !s)} character={character} faces={faces} />}
        {memoryOn && character && memory.memory?.enabled && (
          <button type="button" className="tool" aria-pressed={memory.extractionOn} disabled={memory.busy}
            title="Use a separate paid chat request to suggest facts after replies."
            onClick={memory.toggleExtraction}>Memory suggestions: {memory.extractionOn ? 'on' : 'off'}</button>
        )}
        {branded && <button
          type="button"
          className="tool"
          aria-pressed={!refusalCatch}
          title="The refusal catch holds back the first tokens to catch a refusal and reroute it. Turning it off streams sooner."
          onClick={() => setRefusalCatch((r) => !r)}
        >
          Refusal catch: {refusalCatch ? 'on' : 'off'}
        </button>}
      </div>
      {voiceOn && <VoiceSettings sealed={model === 'anonymo-sealed'} />}
      <div className="dock-meta">
        <span>Enter to send · Shift+Enter for a new line</span>
        <span>{historyOn && keep ? 'Chat history is saved on this device.' : 'Chat history is off on this device.'}</span>
      </div>
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

  const thread = (
    <>
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
        <Stage character={character} faces={faces} turns={turns} streaming={streaming} notices={notices} onLog={() => setStage(false)} />
      ) : compact && !turns.length ? (
        <div className="mascot-welcome">
          {hasFace(faces) ? <FaceAvatar faces={faces} /> : <MascotSprite mood="greet" />}
          <h3>{character?.card.data.name ?? 'What’s on your mind?'}</h3>
          {key ? <p>Start a conversation here.</p> : <Link className="btn btn-primary btn-small" href={setupHref('key', characterDestination('chat', character?.id))}>Create a key to chat</Link>}
        </div>
      ) : turns.length === 0 ? (
        <section className="empty chat-col">
          <div className="empty-hero">
            {hasFace(faces) ? <FaceAvatar faces={faces} /> : <Photo src="/mascot/avatar.jpg" alt="" width={256} height={256} />}
            <div>
              <h1>{character ? character.card.data.name : 'Start a conversation'}</h1>
              <p className="muted">
                {character
                  ? 'This AI character is saved on this device. Switch characters below the message box.'
                  : 'Write a message or start with one of these ideas.'}
              </p>
            </div>
          </div>
          {ready && !key ? (
            <div className="chat-entry">
              <span>Connect a key to send your first message.</span>
              <Link className="btn btn-primary btn-small" href={setupHref('key', characterDestination('chat', character?.id))}>
                Create a key
              </Link>
            </div>
          ) : character ? null : (
            <div className="starters">
              {STARTERS.map((starter) => (
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
          {character && greetingsOf(character.card)[0] && (
            <div className="answer">
              <div className="answer-head">{character.card.data.name}</div>
              <p className="answer-body">{greetingsOf(character.card)[0]}</p>
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
              {turn.prompt && (maskOn ? <MaskedPrompt text={turn.prompt} vault={vault.current} /> : <p className="prompt">{turn.prompt}</p>)}
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
                <AnswerCard turn={turn} characterId={character?.id} proof={proofOn ? {
                  source: sources.current.get(turn.id) ?? null,
                  onForget: () => { sources.current.delete(turn.id); setSourcesVersion((v) => v + 1); },
                } : null} />
              </div>
            </article>
          ))}
          <div ref={end} />
        </div>
      )}
    </>
  );
  return <ChatVoiceContext.Provider value={voiceOn ? voice : null}>{threadHost && createPortal(thread, threadHost)}{key && composerHost && createPortal(composer, composerHost)}</ChatVoiceContext.Provider>;
}

/** Shown with any message that mentions suicide or self-harm. It never blocks the chat. */
function CrisisNotice() {
  return (
    <aside className="notice crisis-notice" aria-label="Crisis support">
      <strong>If you’re thinking about suicide or hurting yourself, you can talk to a person right now.</strong>
      <p className="muted">Free and confidential. If you’re in immediate danger, call your local emergency number.</p>
      <ul>
        {CRISIS_LINES.map((l) => (
          <li key={l.href}>
            <span className="crisis-where">{l.where} ·</span> {l.what}:{' '}
            <a href={l.href} {...(l.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
              {l.action}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
