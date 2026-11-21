'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import type { StoredCharacter } from '@/lib/anonymo/characters-store';
import { AnonymoApiError } from '@/lib/anonymo/client';
import { adultStore } from '@/lib/anonymo/prefs';
import {
  dismissSuggestion, parseMemoryProposals, prepareSuggestions, saveSuggestions, selectMemories, suggestionsFor, withCharacterMemory,
  type CharacterMemory, type MemorySuggestion,
} from '@/lib/anonymo/memory';
import { canReadExchange, memoryRequest, type MemoryCharge } from '@/lib/anonymo/memory-request';
import { editMemory, getMemory, initializeMemory, memorySession } from '@/lib/anonymo/memory-store';
import type { ChatMessage, ChatResult } from '@/lib/anonymo/types';
import { vault } from '@/lib/anonymo/vault-browser';
import { useCharacterMemory } from './memory-state';

type Pending = MemorySuggestion & { key: string; at: string; generation: string };

function available() {
  const mode = vault.state().mode;
  return mode === 'off' || mode === 'unlocked';
}

export function useChatMemory(character: StoredCharacter | null) {
  const { client, demo, key, chatId, turns, setTurns, rememberReceipt, refreshBalance } = useAnonymo();
  const { memory } = useCharacterMemory(demo, character);
  const scope = useMemo(() => ({ chatId, characterId: character?.id, client }), [chatId, character?.id, client]);
  const current = useRef<typeof scope | null>(null);
  const requests = useRef(new Set<AbortController>());
  const deferredCharges = useRef(new Map<string, MemoryCharge>());
  const [batch, setBatch] = useState<{ scope: typeof scope; items: Pending[] } | null>(null);
  const [error, setError] = useState<{ scope: typeof scope; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    current.current = scope;
    return () => { current.current = null; };
  }, [scope]);
  const generation = memory?.generation;
  useEffect(() => {
    setBatch((previous) => previous?.scope === scope && previous.items[0]?.generation === generation ? previous : null);
  }, [scope, generation]);

  useEffect(() => {
    const active = requests.current;
    const charges = deferredCharges.current;
    const stop = () => {
      for (const controller of active) controller.abort();
      active.clear();
    };
    const unlisten = vault.onLock(() => {
      stop();
      charges.clear();
      setBatch(null);
    });
    return () => { unlisten(); stop(); charges.clear(); };
  }, [client]);

  useEffect(() => {
    if (!deferredCharges.current.size) return;
    const charges = new Map<string, MemoryCharge>();
    for (const turn of turns) {
      const charge = deferredCharges.current.get(turn.id);
      if (!charge) continue;
      charges.set(turn.id, charge);
      deferredCharges.current.delete(turn.id);
    }
    if (charges.size) setTurns((list) => list.map((turn) => charges.has(turn.id) ? { ...turn, memoryCharge: charges.get(turn.id) } : turn));
  }, [turns, setTurns]);

  const pending = memory?.enabled && memory.extract && batch?.scope === scope
    ? suggestionsFor(memory, batch.items.filter(({ generation }) => generation === memory.generation))
    : [];

  function addToPrompt(messages: ChatMessage[], latest: string[]) {
    if (!character || !available()) return messages;
    const snapshot = getMemory(demo, character.id);
    return snapshot.enabled ? withCharacterMemory(messages, selectMemories(snapshot.facts, latest)) : messages;
  }

  async function afterReply(id: string, model: string, prompt: string, reply: ChatResult) {
    if (!character || !key || !canReadExchange(reply)) return;
    const characterId = character.id;
    const session = memorySession();
    const currentExchange = () => current.current === scope && session === memorySession() && available() &&
      adultStore.get() && !document.documentElement.hasAttribute('data-anonymo-panic');
    if (!currentExchange()) return;
    const initial = getMemory(demo, characterId);
    if (!initial.enabled || !initial.extract) return;
    setError(null);

    function onCharge(memoryCharge: MemoryCharge) {
      if (current.current?.client !== client || abort.signal.aborted) return;
      if (current.current?.chatId !== chatId) {
        deferredCharges.current.set(id, memoryCharge);
        return;
      }
      setTurns((list) => list.map((turn) => turn.id === id ? { ...turn, memoryCharge } : turn));
    }

    const abort = new AbortController();
    requests.current.add(abort);
    let started = false;
    let accountedFor = false;
    try {
      const saved = initial.generation ? initial : await initializeMemory(demo, character);
      if (!currentExchange() || !saved.enabled || !saved.extract) return;
      const facts = selectMemories(saved.facts, [prompt, reply.content.slice(0, 800)]);
      started = true;
      const result = await client.chat(memoryRequest(model, prompt, reply.content, facts), {
        signal: abort.signal,
        headers: { sealed: reply.receipt?.sealed },
      });
      if (current.current?.client !== client || abort.signal.aborted) return;
      const at = result.receipt?.ts ?? new Date().toISOString();
      if (result.receiptId) rememberReceipt({ id: result.receiptId, model, at });
      const receipt = result.receipt ?? (result.receiptId ? await client.receipt(result.receiptId).then((view) => view.receipt, () => null) : null);
      onCharge({ cost: receipt?.cost ?? null, receiptId: result.receiptId });
      accountedFor = true;
      if (!currentExchange() || !canReadExchange({ ...result, receipt })) return;
      const suggestions = await prepareSuggestions(parseMemoryProposals(result.content), facts);
      if (!suggestions.length || !currentExchange()) return;

      const sameGeneration = (stored: CharacterMemory) => stored.generation === saved.generation && stored.enabled && stored.extract;
      const snapshot = await editMemory(demo, characterId, (stored) =>
        currentExchange() && sameGeneration(stored) && stored.autoSave ? saveSuggestions(stored, suggestions, chatId, at) : stored,
      );
      if (!currentExchange() || !sameGeneration(snapshot) || snapshot.autoSave) return;
      const items = suggestionsFor(snapshot, suggestions).map((item) => ({
        ...item, key: `${id}/${item.fingerprint}`, at, generation: snapshot.generation,
      }));
      if (items.length) setBatch((previous) => {
        const prior = previous?.scope === scope ? previous.items.filter(({ generation }) => generation === snapshot.generation) : [];
        const fingerprints = new Set(prior.map((item) => item.fingerprint));
        return { scope, items: [...prior, ...items.filter((item) => !fingerprints.has(item.fingerprint))].slice(-12) };
      });
    } catch (reason) {
      if (started && !accountedFor && current.current?.client === client && !abort.signal.aborted) {
        const noCharge = reason instanceof AnonymoApiError && [400, 401, 402, 403, 404, 409, 451].includes(reason.status);
        onCharge({ cost: noCharge ? '0' : null, receiptId: null });
      }
      if (currentExchange()) setError({ scope, message: 'Memory suggestions are unavailable for this reply.' });
    } finally {
      requests.current.delete(abort);
      if (started) refreshBalance();
    }
  }

  async function apply(change: (stored: CharacterMemory) => CharacterMemory) {
    if (!character || !available() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await editMemory(demo, character.id, change);
    } catch {
      setError({ scope, message: 'Could not save this change on this device.' });
    } finally {
      setBusy(false);
    }
  }

  function review(item: Pending, accept: boolean) {
    void apply((stored) => {
      if (!stored.enabled || !stored.extract || stored.generation !== item.generation) return stored;
      if (accept) return saveSuggestions(stored, [item], chatId, item.at);
      return dismissSuggestion(stored, item);
    });
  }

  const extractionOn = !!memory?.enabled && memory.extract;
  return {
    addToPrompt, afterReply, memory, pending, busy, review, extractionOn,
    error: error?.scope === scope ? error.message : '',
    toggleExtraction: () => void apply((stored) => stored.enabled && stored.extract === extractionOn
      ? { ...stored, extract: !extractionOn, generation: '' }
      : stored),
  };
}

export function MemorySuggestions({ pending, busy, error, review }: Pick<
  ReturnType<typeof useChatMemory>, 'pending' | 'busy' | 'error' | 'review'
>) {
  if (!pending.length && !error) return null;
  return (
    <section className="memory-suggestions" aria-label="Memory suggestions" aria-live="polite">
      {error && <p className="error-text" role="status">{error}</p>}
      {!!pending.length && (
        <ul>
          {pending.map((item) => (
            <li key={item.key}>
              <span><strong>Remember:</strong> {item.text}</span>
              <div>
                <button type="button" className="btn btn-small" disabled={busy} aria-label={`Save memory: ${item.text}`} onClick={() => review(item, true)}>Save</button>
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} aria-label={`Dismiss memory: ${item.text}`} onClick={() => review(item, false)}>Dismiss</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
