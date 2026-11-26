// Update "voice" (Night Call): the streaming sentence splitter, what a stock voice costs, the sleep timer, which voices
// and recognisers are allowed, and the demo gateway's speech (lib/anonymo/voice.ts, lib/anonymo/mock/voice.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { API_PATHS, createAnonymoClient, mediaReceiptFromHeader } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { DEMO_SPEECH_MODELS, demoStoryReply, demoToneSeconds, VOICE_SAMPLE_FIELDS } from '../lib/anonymo/mock/voice.ts';
import { usdToMusd } from '../lib/anonymo/money.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';
import {
  addClip, addReply, captionAt, captionLines, CHARS_PER_MINUTE, clock, drawnLevel, FADE_MS, FINISH_LIMIT_MS, formatCents, inLanguage, localVoices,
  MAX_PIECE, NO_COST, onDeviceStatus, onDeviceSupport, PACES, sentenceFeed, SLEEP_FAREWELL, SLEEP_MINUTES, SLEEP_OFF, sleepAllowsSpeech, sleepRemaining,
  sleepStep, speakable, speechCostMusd, speechMusdPerMinute, splitSentences, stockVoiceLabel, STORY_CONTINUE, STORY_MINUTES, STORY_PROMPT, textBoxReason,
  threadMessages, totalMusd, VOICE_SAMPLE, wavInfo,
} from '../lib/anonymo/voice.ts';

const base = 'https://demo.anonymo.invalid';

async function demo(credit = 2_000_000) {
  const sent = [];
  const mock = createMockGateway({ delayMs: 0, speechDelayMs: 0 });
  const spy = (input, init) => {
    sent.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : null });
    return mock.fetch(input, init);
  };
  const { key } = await createAnonymoClient({ baseUrl: base, fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl: base, fetch: spy, key });
  if (credit) await mock.simulateDeposit(key, 'rhc', 'USDG', credit);
  return { mock, client, key, sent };
}
const availableMusd = async (client) => usdToMusd((await client.balance()).available_usd);

// ---- The splitter ----------------------------------------------------------------------------------------------------

// Text the way a model writes it: words, sentence ends, quotes, line breaks, numbers, emoji, and the odd long run.
const prose = fc.array(
  fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom('the', 'felt', 'plush', 'listens', 'softly', 'and', 'a', 'paper', 'river', 'Dr', 'e.g', '3.14', 'I', 'so', 'No') },
    { weight: 4, arbitrary: fc.constantFrom(' ', ' ', ' ', '  ', '\n', '\n\n', '\t') },
    { weight: 3, arbitrary: fc.constantFrom('.', '. ', '! ', '? ', '… ', '?! ', '." ', '.) ', ', ', '; ', ': ', ' — ') },
    { weight: 1, arbitrary: fc.constantFrom('😴', '🧸', '1. ', '- ', '**', '"', '’') },
    { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 12 }) },
    { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 6 }) },
  ),
  { maxLength: 120 },
).map((parts) => parts.join(''));
const limits = fc.record({ min: fc.integer({ min: 0, max: 40 }), max: fc.integer({ min: 1, max: 120 }) });

test('the splitter only slices: the pieces and the remainder always join back to the input', () => {
  fc.assert(
    fc.property(fc.oneof(prose, fc.string({ unit: 'binary', maxLength: 400 })), limits, fc.boolean(), (text, opts, flush) => {
      const { pieces, rest } = splitSentences(text, { ...opts, flush });
      assert.equal(pieces.join('') + rest, text);
      assert.ok(pieces.every((p) => p.length > 0), 'no empty piece');
      if (flush) assert.equal(rest, '', 'at the end of the reply nothing is held back');
    }),
    { numRuns: 1500 },
  );
});

test('fed in any chunks, a streamed reply is spoken once and whole', () => {
  fc.assert(
    fc.property(prose, fc.array(fc.integer({ min: 1, max: 17 }), { minLength: 1, maxLength: 60 }), limits, (text, steps, opts) => {
      const feed = sentenceFeed(opts);
      const spoken = [];
      let at = 0;
      for (let i = 0; at < text.length; i++) {
        const next = Math.min(text.length, at + steps[i % steps.length]);
        spoken.push(...feed.push(text.slice(at, next)));
        assert.equal(spoken.join('') + feed.pending(), text.slice(0, next), 'nothing is lost or repeated mid-stream');
        at = next;
      }
      spoken.push(...feed.end());
      assert.equal(spoken.join(''), text);
      assert.equal(feed.pending(), '');
    }),
    { numRuns: 800 },
  );
});

test('a piece never ends inside a character, and long runs are cut near the limit', () => {
  fc.assert(
    fc.property(fc.string({ unit: 'grapheme', maxLength: 300 }).filter((s) => s.isWellFormed()), fc.integer({ min: 1, max: 40 }), (text, max) => {
      const { pieces, rest } = splitSentences(text, { max, min: 0, flush: true });
      assert.equal(rest, '');
      for (const p of pieces) assert.ok(p.isWellFormed(), 'no surrogate pair is split');
    }),
    { numRuns: 500 },
  );
  const run = 'word '.repeat(200);
  const cut = splitSentences(run, { flush: true });
  assert.ok(cut.pieces.length > 3 && cut.pieces.every((p) => p.length <= MAX_PIECE && p.endsWith(' ')), 'cut at word gaps');
  assert.ok(splitSentences(`${'a'.repeat(100)}, ${'b'.repeat(120)} ${'c'.repeat(200)}`, { max: 200, flush: true }).pieces[0].endsWith(', '), 'a clause mark is preferred');
});

test('sentences end at a full stop, question or line break, not inside numbers, abbreviations or an unfinished stream', () => {
  const split = (text, opts) => splitSentences(text, opts).pieces;
  assert.deepEqual(split('The plush sat down. It hugged its knees! Was it late? Not yet.', { flush: true }), ['The plush sat down. ', 'It hugged its knees! ', 'Was it late? ', 'Not yet.']);
  assert.deepEqual(splitSentences('The plush sat down. It hug'), { pieces: ['The plush sat down. '], rest: 'It hug' });
  assert.deepEqual(splitSentences('The plush sat down.'), { pieces: [], rest: 'The plush sat down.' }, 'a full stop still waiting for what follows is not a sentence end yet');
  assert.deepEqual(split('The price is 3.14 dollars today. Fine.', { flush: true }), ['The price is 3.14 dollars today. ', 'Fine.']);
  assert.deepEqual(split('Ask Dr. Vale about it, e.g. tomorrow. Then rest.', { flush: true }), ['Ask Dr. Vale about it, e.g. tomorrow. ', 'Then rest.']);
  assert.deepEqual(split('“Sleep now.” The lamp went out…  Then quiet.', { flush: true }), ['“Sleep now.” ', 'The lamp went out…  ', 'Then quiet.']);
  assert.deepEqual(split('A line about the river\nand a second line here\n\nA new paragraph.', { flush: true }), ['A line about the river\n', 'and a second line here\n\n', 'A new paragraph.']);
  assert.deepEqual(split('1. Breathe in slowly.\n2. Breathe out slowly.', { flush: true }), ['1. Breathe in slowly.\n', '2. Breathe out slowly.']);
  assert.deepEqual(split('Oh. Hm. That is a lovely idea.', { flush: true }), ['Oh. Hm. That is a lovely idea.'], 'very short sentences ride with the next one');
  assert.deepEqual(splitSentences(''), { pieces: [], rest: '' });
});

test('what is spoken has no markup, links or pictographs', () => {
  assert.equal(speakable('**Rest** now, _little_ one. 😴'), 'Rest now, little one.');
  assert.equal(speakable('- Read the [docs](https://example.invalid/docs) at https://example.invalid/x first.\n'), 'Read the docs at first.');
  assert.equal(speakable('## A heading\n> and a quote'), 'A heading and a quote');
  assert.equal(speakable('***'), '');
  assert.equal(speakable(' 🧸 '), '');
  assert.equal(speakable('*smiles*  softly'), 'smiles softly');
});

test('captions break at word gaps and follow the word being said', () => {
  const sentence = 'Only the little printer by the window was awake, humming to itself in the dark.';
  const lines = captionLines(sentence, 30);
  assert.ok(lines.length >= 3 && lines.every((l) => l.text.length <= 30));
  assert.equal(lines.map((l) => l.text).join(' '), sentence);
  assert.ok(lines.every((l) => sentence.startsWith(l.text.split(' ')[0], l.start)));
  assert.equal(captionAt(lines, 0), lines[0].text);
  assert.equal(captionAt(lines, lines[1].start + 2), lines[1].text);
  assert.equal(captionAt(lines, 10_000), lines.at(-1).text);
  assert.equal(captionAt([], 3), '');
  assert.deepEqual(captionLines('supercalifragilistic', 5), [{ text: 'supercalifragilistic', start: 0 }], 'one long word is one line');
});

// ---- Money -----------------------------------------------------------------------------------------------------------

test('speech is priced per 1,000 characters, rounded up, in whole micro-USD', () => {
  assert.equal(speechCostMusd('0.015', 1000), 15_000);
  assert.equal(speechCostMusd('0.015', 1), 15);
  assert.equal(speechCostMusd('0.015', VOICE_SAMPLE.length), VOICE_SAMPLE.length * 15);
  assert.equal(speechCostMusd('0.0001', 1), 1, 'a fraction of a micro-USD rounds up, as the gateway rounds up');
  assert.equal(speechCostMusd('0.0001', 0), 0);
  assert.equal(speechCostMusd(0.03, 4096), 122_880);
  assert.ok(Number.isNaN(speechCostMusd('free', 10)));
  assert.ok(Number.isNaN(speechCostMusd('0.015', -1)));
  assert.ok(Number.isNaN(speechCostMusd('0.015', 1.5)));
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 999_999 }), fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 0, max: 5000 }), (per1kMusd, a, b) => {
      const price = (per1kMusd / 1_000_000).toFixed(6);
      const [ca, cb, both] = [speechCostMusd(price, a), speechCostMusd(price, b), speechCostMusd(price, a + b)];
      assert.ok(Number.isSafeInteger(ca) && ca >= 0);
      assert.ok(both >= ca && both >= cb, 'more text never costs less');
      assert.ok(ca + cb >= both && ca + cb - both <= 1, 'sentence by sentence costs at most one micro-USD more per extra clip');
      assert.ok(both * 1000 >= per1kMusd * (a + b) && (both - 1) * 1000 < per1kMusd * (a + b), 'the exact price, rounded up');
    }),
    { numRuns: 500 },
  );
});

test('the price before a call is cents per minute of speech', () => {
  assert.equal(CHARS_PER_MINUTE, 900);
  assert.equal(speechMusdPerMinute('0.015'), 13_500);
  assert.equal(formatCents(speechMusdPerMinute('0.015')), '1.4¢');
  assert.equal(formatCents(speechMusdPerMinute('0.030')), '2.7¢');
  assert.deepEqual(PACES.map((p) => [p.id, formatCents(speechMusdPerMinute('0.015', p.speed))]), [['calm', '1.2¢'], ['even', '1.4¢'], ['brisk', '1.6¢']], 'a quicker pace says more characters a minute');
  assert.ok(Number.isNaN(speechMusdPerMinute('0.015', 0)));
  assert.deepEqual([0, 49, 50, 510, 5000, 9949, 9950, 10_000, 13_500, 125_000, 999_400, 999_600, 1_240_000, Number.NaN].map(formatCents),
    ['0¢', '<0.01¢', '0.01¢', '0.05¢', '0.5¢', '0.99¢', '1¢', '1¢', '1.4¢', '12.5¢', '99.9¢', '$0.99', '$1.24', '—']);
});

test('the running total adds every clip and every reply, in micro-USD', () => {
  let cost = NO_COST;
  cost = addClip(cost, 510, 34);
  cost = addClip(cost, 1500, 100);
  cost = addReply(cost, usdToMusd('0.000912'));
  cost = addClip(cost, Number.NaN, 20); // a clip whose charge was not reported adds no amount
  cost = addReply(cost, Number.NaN);
  assert.deepEqual(cost, { voiceMusd: 2010, replyMusd: 912, clips: 3, chars: 154, replies: 2 });
  assert.equal(totalMusd(cost), 2922);
  assert.equal(formatCents(totalMusd(cost)), '0.29¢');
  assert.deepEqual(NO_COST, { voiceMusd: 0, replyMusd: 0, clips: 0, chars: 0, replies: 0 }, 'the starting value is never changed');
  fc.assert(
    fc.property(fc.array(fc.record({ musd: fc.integer({ min: 0, max: 500_000 }), chars: fc.integer({ min: 1, max: 4096 }) }), { maxLength: 60 }), (clips) => {
      const sum = clips.reduce((c, clip) => addClip(c, clip.musd, clip.chars), NO_COST);
      assert.equal(sum.voiceMusd, clips.reduce((s, c) => s + c.musd, 0));
      assert.equal(sum.clips, clips.length);
      assert.ok(Number.isSafeInteger(totalMusd(sum)));
    }),
  );
  assert.deepEqual([0, 999, 61_000, 3_599_000, 3_725_000, -5].map(clock), ['0:00', '0:00', '1:01', '59:59', '1:02:05', '0:00']);
});

// ---- The sleep timer -------------------------------------------------------------------------------------------------

test('the sleep timer finishes the sentence, fades, then ends on the farewell', () => {
  assert.deepEqual([...SLEEP_MINUTES], [0, 10, 20, 30, 45]);
  assert.equal(STORY_MINUTES, 20);
  assert.equal(SLEEP_FAREWELL, 'Thank you. Sleep well.');
  const t0 = 1_000_000;
  let s = sleepStep(SLEEP_OFF, { type: 'set', minutes: 20, now: t0 });
  assert.deepEqual(s, { phase: 'running', minutes: 20, endsAt: t0 + 20 * 60_000 });
  assert.equal(sleepRemaining(s, t0 + 60_000), 19 * 60_000);
  assert.equal(sleepAllowsSpeech(s), true);
  assert.equal(sleepStep(s, { type: 'tick', now: t0 + 20 * 60_000 - 1, speaking: true }), s, 'not yet');

  // Time runs out mid-sentence: the sentence is allowed to end, and nothing new may start.
  const end = t0 + 20 * 60_000;
  s = sleepStep(s, { type: 'tick', now: end, speaking: true });
  assert.deepEqual(s, { phase: 'finishing', minutes: 20, since: end });
  assert.equal(sleepAllowsSpeech(s), false);
  assert.equal(sleepStep(s, { type: 'tick', now: end + 500, speaking: true }), s, 'still finishing while the sentence runs');
  s = sleepStep(s, { type: 'sentence-end', now: end + 2000 });
  assert.deepEqual(s, { phase: 'fading', minutes: 20, until: end + 2000 + FADE_MS });
  assert.equal(sleepStep(s, { type: 'tick', now: end + 2000 + FADE_MS - 1, speaking: false }), s);
  s = sleepStep(s, { type: 'tick', now: end + 2000 + FADE_MS, speaking: false });
  assert.deepEqual(s, { phase: 'done', minutes: 20 });
  assert.equal(sleepAllowsSpeech(s), false);
  assert.equal(sleepStep(s, { type: 'set', minutes: 10, now: end + 99_999 }), s, 'the call has ended: the farewell stays');
  assert.equal(sleepStep(s, { type: 'tick', now: end + 9e9, speaking: true }), s);
  assert.deepEqual(sleepStep(s, { type: 'cancel' }), SLEEP_OFF);
});

test('the sleep timer skips straight to the fade in silence, and never waits forever', () => {
  const running = sleepStep(SLEEP_OFF, { type: 'set', minutes: 10, now: 0 });
  assert.deepEqual(sleepStep(running, { type: 'tick', now: 600_000, speaking: false }), { phase: 'fading', minutes: 10, until: 600_000 + FADE_MS });
  assert.equal(sleepStep(running, { type: 'sentence-end', now: 599_999 }), running);
  assert.deepEqual(sleepStep(running, { type: 'sentence-end', now: 600_000 }), { phase: 'fading', minutes: 10, until: 600_000 + FADE_MS });
  const finishing = sleepStep(running, { type: 'tick', now: 600_000, speaking: true });
  assert.deepEqual(sleepStep(finishing, { type: 'tick', now: 600_100, speaking: false }).phase, 'fading', 'a missed sentence end is caught by the next tick');
  assert.deepEqual(sleepStep(finishing, { type: 'tick', now: 600_000 + FINISH_LIMIT_MS, speaking: true }).phase, 'fading', 'a sentence that never ends is not waited for');
  // Turning it off, or setting it again before the farewell, starts over.
  assert.deepEqual(sleepStep(running, { type: 'set', minutes: 0, now: 5 }), SLEEP_OFF);
  assert.deepEqual(sleepStep(finishing, { type: 'set', minutes: 10, now: 700_000 }), { phase: 'running', minutes: 10, endsAt: 1_300_000 });
  assert.deepEqual(sleepStep(SLEEP_OFF, { type: 'tick', now: 9e12, speaking: true }), SLEEP_OFF, 'off stays off');
  assert.deepEqual(sleepStep(SLEEP_OFF, { type: 'sentence-end', now: 1 }), SLEEP_OFF);
  assert.deepEqual(sleepStep(SLEEP_OFF, { type: 'set', minutes: Number.NaN, now: 1 }), SLEEP_OFF);
});

test('whatever happens, the sleep timer only moves forward and stops speech once time is up', () => {
  const order = { off: 0, running: 1, finishing: 2, fading: 3, done: 4 };
  const event = fc.oneof(
    { weight: 6, arbitrary: fc.record({ type: fc.constant('tick'), dt: fc.integer({ min: 0, max: 400_000 }), speaking: fc.boolean() }) },
    { weight: 2, arbitrary: fc.record({ type: fc.constant('sentence-end'), dt: fc.integer({ min: 0, max: 5000 }) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('set'), dt: fc.integer({ min: 0, max: 5000 }), minutes: fc.constantFrom(...SLEEP_MINUTES) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('cancel'), dt: fc.constant(0) }) },
  );
  fc.assert(
    fc.property(fc.array(event, { maxLength: 80 }), (events) => {
      let now = 0;
      let state = SLEEP_OFF;
      for (const e of events) {
        now += e.dt;
        const next = sleepStep(state, { ...e, now });
        assert.ok(next.phase in order);
        if (e.type === 'tick' || e.type === 'sentence-end') {
          assert.ok(order[next.phase] >= order[state.phase], 'time passing never rewinds the timer');
          assert.ok(order[next.phase] - order[state.phase] <= (state.phase === 'running' ? 2 : 1), 'no phase is skipped, except straight to the fade in silence');
          if (state.phase === 'off') assert.equal(next.phase, 'off', 'a timer that is off never ends a call');
          if (next.phase === 'done') assert.ok(state.phase === 'fading' || state.phase === 'done', 'the farewell only follows the fade');
        }
        if (next.phase === 'running') assert.ok(e.type === 'set' ? next.endsAt === now + next.minutes * 60_000 : next.endsAt > now, 'a running timer has time left');
        assert.equal(sleepAllowsSpeech(next), next.phase === 'off' || next.phase === 'running');
        state = next;
      }
    }),
    { numRuns: 600 },
  );
});

// ---- Voices and listening ---------------------------------------------------------------------------------------------

const voice = (name, lang, localService, extra = {}) => ({ name, lang, localService, voiceURI: `uri:${name}`, ...extra });

test('only voices this device speaks itself are offered', () => {
  const voices = [
    voice('Cloud One', 'en-US', false),
    voice('Local Nord', 'nb-NO', true),
    voice('Local Plain', 'en-GB', true),
    voice('Local Default', 'en-US', true, { default: true }),
    voice('Truthy Flag', 'en-US', 1),
    voice('String Flag', 'en-US', 'true'),
    voice('No Flag', 'en-US', undefined),
    voice('Local Plain', 'en-GB', true), // listed twice by some browsers
    { name: '', lang: 'en-US', localService: true, voiceURI: 'uri:blank' },
  ];
  const kept = localVoices(voices, 'en-US');
  assert.deepEqual(kept.map((v) => v.name), ['Local Default', 'Local Plain', 'Local Nord'], 'the person’s language first, the default first within it');
  assert.equal(inLanguage(kept, 'en-US'), 2);
  assert.deepEqual(localVoices(voices, 'nb').map((v) => v.name)[0], 'Local Nord');
  assert.deepEqual(localVoices([], 'en'), []);
  assert.deepEqual(localVoices([voice('Cloud Two', 'en-US', false)], 'en'), [], 'no local voice: the device option is not offered at all');
  fc.assert(
    fc.property(
      fc.array(fc.record({ name: fc.string({ maxLength: 8 }), lang: fc.constantFrom('en-US', 'en-GB', 'fr-FR', 'ja-JP', ''), localService: fc.constantFrom(true, false, 1, 0, 'true', null, undefined), voiceURI: fc.string({ maxLength: 4 }) }), { maxLength: 40 }),
      fc.constantFrom('en', 'fr-CA', 'ja', ''),
      (list, lang) => {
        const out = localVoices(list, lang);
        assert.ok(out.every((v) => v.localService === true), 'nothing but exactly true gets through');
        assert.ok(out.every((v) => list.includes(v)), 'only voices the browser listed');
        assert.equal(new Set(out.map((v) => v.voiceURI)).size, out.length, 'no voice twice');
        assert.equal(out.length, new Set(list.filter((v) => v.localService === true && v.voiceURI && v.name).map((v) => v.voiceURI)).size, 'and every local voice is offered');
      },
    ),
  );
});

test('stock voices get readable labels and nothing else is invented', () => {
  assert.deepEqual(stockVoiceLabel('af_heart'), { name: 'Heart', note: 'American English' });
  assert.deepEqual(stockVoiceLabel('bm_fable'), { name: 'Fable', note: 'British English' });
  assert.deepEqual(stockVoiceLabel('jf_alpha'), { name: 'Alpha', note: 'Japanese' });
  assert.deepEqual(stockVoiceLabel('vox-ava'), { name: 'Ava', note: null });
  assert.deepEqual(stockVoiceLabel('cb-default'), { name: 'Default', note: null });
  assert.deepEqual(stockVoiceLabel('cherry'), { name: 'Cherry', note: null });
  assert.deepEqual(stockVoiceLabel('xq_odd-one'), { name: 'Xq Odd One', note: null });
});

test('the recogniser is used only when it can be held to this device', () => {
  class OnDevice {
    static available() {}
    static install() {}
    get processLocally() { return false; }
    set processLocally(_v) {}
  }
  class CloudOnly {} // the older prefixed recogniser: no switch, no way to ask
  class NoSwitch { static available() {} static install() {} }
  class NoInstall { static available() {} get processLocally() { return false; } }
  assert.equal(onDeviceSupport(OnDevice), true);
  assert.equal(onDeviceSupport(class extends OnDevice {}), true);
  for (const ctor of [CloudOnly, NoSwitch, NoInstall, undefined, null, {}, 'SpeechRecognition', () => {}]) assert.equal(onDeviceSupport(ctor), false);
  assert.deepEqual(['available', 'downloadable', 'downloading', 'unavailable', 'maybe', undefined, true].map(onDeviceStatus),
    ['available', 'downloadable', 'downloading', 'unavailable', 'unavailable', 'unavailable', 'unavailable'], 'anything unknown counts as unavailable');
  assert.equal(textBoxReason('available', 'en-US'), null);
  for (const status of ['unsupported', 'unavailable', 'downloadable', 'downloading']) {
    const why = textBoxReason(status, 'en-US');
    assert.ok(why && /type/i.test(why), `${status} explains the text box`);
  }
  assert.match(textBoxReason('unsupported', 'en-US'), /never sends your voice to a cloud recogniser/);
  assert.match(textBoxReason('unavailable', 'nb-NO'), /nb-NO/);
});

test('a device voice gets a drawn swell that stays between 0 and 1', () => {
  fc.assert(
    fc.property(fc.double({ min: 0, max: 600_000, noNaN: true }), fc.oneof(fc.double({ min: 0, max: 20_000, noNaN: true }), fc.constant(Number.POSITIVE_INFINITY)), (t, w) => {
      const level = drawnLevel(t, w);
      assert.ok(level >= 0 && level <= 1);
    }),
  );
  assert.ok(drawnLevel(100, 0) > drawnLevel(100, 2000), 'a word just spoken is louder than a pause');
  assert.equal(drawnLevel(-1, 0), 0);
  assert.equal(drawnLevel(Number.NaN, 0), 0);
});

// ---- The thread and the demo gateway ---------------------------------------------------------------------------------

test('a call sends the thread exactly as chat does', () => {
  const turns = [
    { status: 'done', prompt: 'Recap of “x”', content: 'They are on a boat.', recap: true },
    { status: 'done', prompt: 'Hello', content: 'Hi.' },
    { status: 'error', prompt: 'lost', content: '' },
    { status: 'stopped', prompt: 'Go on', content: 'Well' },
    { status: 'stopped', prompt: 'Cut off at once', content: '' },
    { status: 'streaming', prompt: 'now', content: 'par' },
  ];
  const messages = threadMessages(turns);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.match(messages[0].content, /recap of our earlier conversation[\s\S]*They are on a boat\.$/);
  assert.deepEqual(messages.slice(2), [
    { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi.' },
    { role: 'user', content: 'Go on' }, { role: 'assistant', content: 'Well' },
    { role: 'user', content: 'Cut off at once' },
  ]);
});

test('voice is opt-in, and the demo lists one stock speech model with a few voices', async () => {
  assert.equal(parseUpdates(undefined).has('voice'), false);
  assert.equal(parseUpdates('voice').has('voice'), true);
  assert.equal(parseUpdates('all').has('voice'), true);
  assert.equal(updateOn('voice', true), true);
  for (const id of ['compare', 'vanish', 'vault', 'video']) assert.equal(parseUpdates('all').has(id), true, `${id} is still an update`);
  const { client } = await demo(0);
  const models = await client.speechModels();
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], DEMO_SPEECH_MODELS[0]);
  assert.equal(models[0].pricing.usd_per_1k_chars, '0.015');
  assert.ok(models[0].voices.length >= 3 && models[0].voices.length <= 6);
  assert.deepEqual(models[0].response_formats, ['wav']);
  const all = (await client.mediaModels()).data;
  assert.ok(all.some((m) => m.kind === 'image') && all.some((m) => m.kind === 'video'), 'the image and video models are still listed');
  assert.equal(API_PATHS.speech, '/v1/audio/speech');
});

test('the demo speaks with a short valid WAV tone, labelled as a demo, charged once with a receipt', async () => {
  const { client } = await demo();
  const [model] = await client.speechModels();
  const before = await availableMusd(client);
  const result = await client.speech({ model: model.id, input: VOICE_SAMPLE, voice: model.voices[0], speed: 1 });
  const wav = wavInfo(result.audio);
  assert.ok(wav, 'the reply is a WAV file');
  assert.deepEqual([wav.channels, wav.bitsPerSample, wav.sampleRate], [1, 16, 16_000]);
  assert.ok(Math.abs(wav.seconds - demoToneSeconds(VOICE_SAMPLE.length, 1)) < 0.01 && wav.seconds < 5, 'short, and about as long as the words would take');
  assert.equal(result.provenance, 'demo', 'labelled as a demo tone');
  assert.equal(result.costMusd, speechCostMusd(model.pricing.usd_per_1k_chars, VOICE_SAMPLE.length));
  assert.equal(before - (await availableMusd(client)), result.costMusd, 'the balance drops by exactly what was reported');
  assert.match(result.requestId, /^med_demo_[0-9a-f]{24}$/);
  assert.equal(result.receipt.payload.request_id, result.requestId);
  assert.deepEqual([result.receipt.payload.kind, result.receipt.payload.unit, result.receipt.payload.media_units, result.receipt.payload.provenance], ['media', 'character', VOICE_SAMPLE.length, 'demo']);
  assert.equal(usdToMusd(result.receipt.payload.cost_usd), result.costMusd);
  assert.match(result.receipt.payload.outputs_sha256[0], /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result.receipt).includes(VOICE_SAMPLE), false, 'the receipt carries no text');
  // A different voice hums at a different pitch; a quicker pace is a shorter clip.
  const other = await client.speech({ model: model.id, input: VOICE_SAMPLE, voice: model.voices[2], speed: 1 });
  assert.notDeepEqual(new Uint8Array(other.audio), new Uint8Array(result.audio));
  const brisk = await client.speech({ model: model.id, input: 'a'.repeat(300), voice: model.voices[0], speed: 2 });
  assert.equal(wavInfo(brisk.audio).seconds, 10);
  assert.equal(wavInfo(new Uint8Array(64)), null);
  assert.equal(wavInfo(new TextEncoder().encode('{"error":"not audio at all, just some text that is long enough"}')), null);
});

test('a call’s running total matches what the key was charged, clip by clip and reply by reply', async () => {
  const { client } = await demo();
  const [model] = await client.speechModels();
  const before = await availableMusd(client);
  const reply = await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: STORY_PROMPT }] });
  assert.match(reply.content, /^Once the lamps were low, a small felt plush/, 'the demo answers the bedtime starter with a story');
  let cost = addReply(NO_COST, usdToMusd(reply.receipt.cost));
  const feed = sentenceFeed();
  const pieces = [...feed.push(reply.content), ...feed.end()].map(speakable).filter(Boolean);
  assert.ok(pieces.length >= 4, 'the story is spoken sentence by sentence');
  for (const piece of pieces) {
    const clip = await client.speech({ model: model.id, input: piece, voice: 'af_heart', speed: 0.9 });
    cost = addClip(cost, clip.costMusd, piece.length);
  }
  assert.equal(cost.clips, pieces.length);
  assert.equal(cost.chars, pieces.reduce((n, p) => n + p.length, 0));
  assert.equal(before - (await availableMusd(client)), totalMusd(cost));
  assert.equal(cost.voiceMusd, cost.chars * 15, 'at $0.015 per 1,000 characters every character is 15 micro-USD');
});

test('stock voices only: no voice sample is ever sent, and the demo refuses one like the gateway', async () => {
  const { client, key, mock, sent } = await demo();
  const sneaky = { model: 'kokoro', input: 'Hello there.', voice: 'af_heart', speed: 1, reference_audio: 'UklGRg==', speaker_wav: 'x', voice_sample: 'x', clone: true };
  await client.speech(sneaky);
  const body = JSON.parse(sent.find((r) => r.url.endsWith(API_PATHS.speech)).body);
  assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'response_format', 'speed', 'voice'], 'the client sends these five fields and nothing else');
  assert.deepEqual(body, { model: 'kokoro', input: 'Hello there.', voice: 'af_heart', speed: 1, response_format: 'wav' });
  assert.equal(VOICE_SAMPLE_FIELDS.length, 11);

  const raw = (payload, headers = { 'content-type': 'application/json' }) =>
    mock.fetch(`${base}${API_PATHS.speech}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const before = await availableMusd(client);
  for (const field of VOICE_SAMPLE_FIELDS) {
    const res = await raw({ model: 'kokoro', input: 'Hello there.', voice: 'af_heart', [field]: 'data:audio/wav;base64,UklGRg==' });
    assert.equal(res.status, 400, field);
    assert.equal((await res.json()).error.type, 'voice_clone_not_supported');
  }
  const refusals = [
    [{ model: 'kokoro', input: 'Hello there.', voice: { sample: 'x' } }, 400, 'voice_clone_not_supported'],
    [{ model: 'kokoro', input: 'Hello there.', voice: 'someone_else' }, 400, 'voice_not_available'],
    [{ model: 'no-such-model', input: 'Hello there.', voice: 'af_heart' }, 404, 'model_not_found'],
    [{ model: 'kokoro', input: '   ', voice: 'af_heart' }, 400, 'invalid_request'],
    [{ model: 'kokoro', input: 'x'.repeat(4097), voice: 'af_heart' }, 400, 'invalid_request'],
    [{ model: 'kokoro', input: 'Hello there.', voice: 'af_heart', speed: 9 }, 400, 'invalid_request'],
    [{ model: 'kokoro', input: 'Hello there.', voice: 'af_heart', response_format: 'mp3' }, 400, 'unsupported_format'],
  ];
  for (const [payload, status, type] of refusals) {
    const res = await raw(payload);
    assert.equal(res.status, status, type);
    assert.equal((await res.json()).error.type, type);
  }
  assert.equal((await raw('RIFF....WAVE', { 'content-type': 'audio/wav' })).status, 415, 'an uploaded file is not accepted');
  assert.equal((await mock.fetch(`${base}${API_PATHS.speech}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'speech needs a key');
  assert.equal(await availableMusd(client), before, 'a refused request costs nothing');
  // With no voice given the model's first stock voice is used, as on the gateway.
  assert.equal((await raw({ model: 'kokoro', input: 'Hello there.' })).status, 200);
});

test('speech with too little credit is refused as out of credit, and nothing is charged', async () => {
  const { client, mock, key } = await demo(0);
  await assert.rejects(client.speech({ model: 'kokoro', input: VOICE_SAMPLE, voice: 'af_heart' }), (e) => e.status === 402 && e.code === 'insufficient_balance');
  await mock.simulateDeposit(key, 'rhc', 'USDG', 100);
  await assert.rejects(client.speech({ model: 'kokoro', input: VOICE_SAMPLE, voice: 'af_heart' }), (e) => e.status === 402);
  assert.equal(await availableMusd(client), 100);
  assert.ok((await client.speech({ model: 'kokoro', input: 'Hi.', voice: 'af_heart' })).costMusd === 45, 'three characters still fit');
  assert.equal(await availableMusd(client), 55);
});

test('the receipt header of a media reply is read without trusting it', () => {
  const header = Buffer.from(JSON.stringify({ payload: { request_id: 'med_x', cost_usd: '0.00051' }, key_id: 'k1', sig: 'abc' })).toString('base64url');
  assert.deepEqual(mediaReceiptFromHeader(header), { payload: { request_id: 'med_x', cost_usd: '0.00051' }, key_id: 'k1', sig: 'abc' });
  for (const bad of [null, '', 'not base64 at all !!', Buffer.from('[]').toString('base64url'), Buffer.from('{"payload":{}}').toString('base64url')]) assert.equal(mediaReceiptFromHeader(bad), null);
});

test('the demo story continues part by part, and only for the bedtime starter', async () => {
  const user = (content) => ({ role: 'user', content });
  const bot = (content) => ({ role: 'assistant', content });
  assert.equal(demoStoryReply([user('Hello')]), null);
  assert.equal(demoStoryReply([user(STORY_CONTINUE)]), null, 'no story was started');
  const one = demoStoryReply([user(STORY_PROMPT)]);
  const two = demoStoryReply([user(STORY_PROMPT), bot(one), user(STORY_CONTINUE)]);
  assert.match(one, /^Once the lamps were low/);
  assert.match(two, /^Along the bank, gold threads glowed/);
  assert.equal(demoStoryReply([user(STORY_PROMPT), bot(one), user('What was that sound?')]), null, 'anything else gets the usual reply');
  let thread = [user(STORY_PROMPT)];
  const parts = [];
  for (let i = 0; i < 9; i++) {
    const part = demoStoryReply(thread);
    assert.ok(part && part.length > 200);
    parts.push(part);
    thread = [...thread, bot(part), user(STORY_CONTINUE)];
  }
  assert.equal(new Set(parts.slice(0, 4)).size, 4, 'four parts before it drifts on');
  assert.equal(parts[4], parts[1], 'then it carries on from the second part');
  assert.doesNotMatch(parts.join(' '), /\b(moon|profit|invest\w*)\b/i);
  const { client } = await demo();
  const usual = await client.chat({ model: 'anonymo-1', messages: [user('Hello')] });
  assert.match(usual.content, /^This is a demo answer/);
});
