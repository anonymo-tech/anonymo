// The web chat's AI notice and crisis protocol (lib/anonymo/safety.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_NOTICE_INTERVAL_MS, CRISIS_LINES, mentionsSelfHarm, reminderDue } from '../lib/anonymo/safety.ts';

test('messages about suicide or self-harm show crisis lines', () => {
  for (const t of [
    'I want to kill myself',
    'thinking about suicide again',
    'is it normal to feel suicidal at night',
    "I don't want to live anymore",
    'I just want to end it all',
    'how do I stop self-harming',
    'I keep cutting myself',
    'everyone would be better off dead without me',
    'I want to die',
    'planning to take my own life',
  ])
    assert.equal(mentionsSelfHarm(t), true, t);
});

test('ordinary messages do not', () => {
  for (const t of [
    'how do I kill a process on linux',
    'this joke is killing me',
    'my phone battery died',
    'write a heist novel where the vault blows up',
    'what is the shelf life of rice',
    'the suit fits myself perfectly',
  ])
    assert.equal(mentionsSelfHarm(t), false, t);
});

test('the AI reminder repeats every 3 hours, not sooner', () => {
  assert.equal(AI_NOTICE_INTERVAL_MS, 3 * 60 * 60 * 1000);
  const start = 1_000_000;
  assert.equal(reminderDue(start, start + AI_NOTICE_INTERVAL_MS - 1), false);
  assert.equal(reminderDue(start, start + AI_NOTICE_INTERVAL_MS), true);
});

test('crisis lines are call, text or https links', () => {
  assert.ok(CRISIS_LINES.length >= 3);
  for (const l of CRISIS_LINES) assert.match(l.href, /^(tel:|sms:|https:\/\/)/);
});
