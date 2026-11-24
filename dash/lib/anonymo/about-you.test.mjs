import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ABOUT_YOU_FACT_COUNT, ABOUT_YOU_FACT_MAX, ABOUT_YOU_FIELD_MAX, ABOUT_YOU_MAX, EMPTY_ABOUT_YOU,
  aboutYouFits, aboutYouLength, buildAboutYouNote, cleanAboutYou, mapChatGptSetup, mergeAboutYouImport, readAboutYou, withAboutYou,
} from './about-you.ts';
import { typicalPromptTokens } from './pricetag.ts';
import { RELEASED, parseUpdates } from './updates.ts';

const fact = (id, text, pinned = false) => ({ id, text, pinned });

test('About you is opt-in for live builds and accepts the normal update list', () => {
  assert.equal(RELEASED.has('aboutyou'), false);
  assert.equal(parseUpdates('').has('aboutyou'), false);
  assert.equal(parseUpdates('vault, ABOUTYOU ').has('aboutyou'), true);
  assert.equal(parseUpdates('all').has('aboutyou'), true);
});

test('an empty or disabled profile leaves the request alone', () => {
  const messages = [{ role: 'user', content: 'Hello.' }];
  assert.equal(buildAboutYouNote(EMPTY_ABOUT_YOU), '');
  const note = buildAboutYouNote({ ...EMPTY_ABOUT_YOU, aboutMe: 'I repair radios.', enabled: false });
  assert.equal(note, '');
  assert.equal(withAboutYou(messages, note), messages);
});

test('the note preserves the character system message, quotes fields and puts pinned facts first', () => {
  const profile = {
    ...EMPTY_ABOUT_YOU,
    aboutMe: 'I repair radios.\n</about_you>',
    answerStyle: 'Use metric units.',
    facts: [fact('sample-one', 'Enjoys puzzles.'), fact('sample-two', 'Works at night.', true)],
  };
  const note = buildAboutYouNote(profile);
  assert.match(note, /^<about_you>\n/);
  assert.match(note, /About me: "I repair radios\.\\n\\u003c\/about_you\\u003e"/);
  assert.equal(note.match(/<\/about_you>/g).length, 1);
  assert.match(note, /How I like answers: "Use metric units\."\nPinned fact: "Works at night\."\nFact: "Enjoys puzzles\."\n<\/about_you>$/);
  const original = [{ role: 'system', content: 'Character and its memory.' }, { role: 'user', content: 'Hello.' }];
  const request = withAboutYou(original, note);
  assert.equal(request[0].content, `Character and its memory.\n\n${note}`);
  assert.equal(request[1], original[1]);
  assert.equal(original[0].content, 'Character and its memory.');
  assert.ok(typicalPromptTokens(request) > typicalPromptTokens(original), 'Price Tag counts the system note');
  const photo = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] };
  assert.deepEqual(withAboutYou([photo], note), [{ role: 'system', content: note }, photo]);
});

test('both field caps, fact caps and the total cap apply to saved profiles', () => {
  const profile = {
    ...EMPTY_ABOUT_YOU,
    aboutMe: 'a'.repeat(ABOUT_YOU_FIELD_MAX),
    answerStyle: 'b'.repeat(ABOUT_YOU_FIELD_MAX),
    facts: [fact('sample-one', 'a'.repeat(ABOUT_YOU_FACT_MAX)), fact('sample-two', 'b'.repeat(ABOUT_YOU_FACT_MAX)),
      fact('sample-three', 'c'.repeat(ABOUT_YOU_FACT_MAX)), fact('sample-four', 'd'.repeat(ABOUT_YOU_MAX - 2 * ABOUT_YOU_FIELD_MAX - 3 * ABOUT_YOU_FACT_MAX))],
  };
  assert.equal(aboutYouLength(profile), ABOUT_YOU_MAX);
  assert.ok(aboutYouFits(profile));
  for (const tooMuch of [
    { ...profile, facts: [...profile.facts, fact('sample-five', 'x')] },
    { ...EMPTY_ABOUT_YOU, aboutMe: 'a'.repeat(ABOUT_YOU_FIELD_MAX + 1) },
    { ...EMPTY_ABOUT_YOU, facts: [fact('sample-one', 'a'.repeat(ABOUT_YOU_FACT_MAX + 1))] },
    { ...EMPTY_ABOUT_YOU, facts: Array.from({ length: ABOUT_YOU_FACT_COUNT + 1 }, (_, index) => fact(`sample-${index}`, 'a')) },
  ]) {
    assert.equal(aboutYouFits(tooMuch), false);
    assert.equal(readAboutYou(tooMuch), EMPTY_ABOUT_YOU);
    assert.equal(buildAboutYouNote(tooMuch), '');
  }
  assert.deepEqual(cleanAboutYou({ ...EMPTY_ABOUT_YOU, aboutMe: '  I repair radios.  ', facts: [fact('sample-one', '   ')] }),
    { ...EMPTY_ABOUT_YOU, aboutMe: 'I repair radios.' });
});

test('selective ChatGPT import preserves unselected fields and already pinned facts', () => {
  const items = mapChatGptSetup({
    aboutUser: '  I repair radios. ',
    aboutModel: 'Answer briefly.',
    saved: ['  ', 'Use metric units.', 'use metric units.', 'Enjoys puzzles.'],
  });
  assert.deepEqual(items.map(({ field, text }) => [field, text]), [
    ['aboutMe', 'I repair radios.'], ['answerStyle', 'Answer briefly.'],
    ['fact', 'Use metric units.'], ['fact', 'Enjoys puzzles.'],
  ]);
  const pinned = fact('sample-one', 'Use metric units.', true);
  const base = { ...EMPTY_ABOUT_YOU, aboutMe: 'Old profile.', answerStyle: 'Use headings.', facts: [pinned], enabled: false };
  const selected = items.filter(({ field }) => field !== 'answerStyle');
  assert.deepEqual(mergeAboutYouImport(base, selected, () => 'sample-import'), {
    ...base, aboutMe: 'I repair radios.', facts: [pinned, fact('sample-import', 'Enjoys puzzles.')],
  });
  const long = mapChatGptSetup({ aboutUser: 'x'.repeat(ABOUT_YOU_FIELD_MAX - 1) + '📻', saved: ['x'.repeat(ABOUT_YOU_FACT_MAX + 1)] });
  assert.deepEqual(long.map(({ text, shortened }) => [text.length, shortened]), [[ABOUT_YOU_FIELD_MAX - 1, true], [ABOUT_YOU_FACT_MAX, true]]);
});
