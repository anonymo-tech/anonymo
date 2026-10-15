import test from 'node:test';
import assert from 'node:assert/strict';
import { appendChatDraft, quotedReplyDraft } from '../lib/chat-drafts.ts';
import { chatBillingSummary } from '../lib/chat-billing.ts';
import { shouldSubmitChatKey, validChatSendKey } from '../lib/chat-send-key.ts';

test('quote and reuse drafts preserve unsent text including trailing whitespace', () => {
  assert.equal(appendChatDraft('My draft  ', 'Earlier question'), 'My draft  \n\nEarlier question');
  assert.equal(quotedReplyDraft('Keep this', 'Claude', 'First\nSecond'), 'Keep this\n\nAbout this passage from Claude:\n> First\n> Second\n\n');
  assert.equal(appendChatDraft('', 'Question'), 'Question');
});
test('settled totals use exact integer microdollars', () => {
  const result = chatBillingSummary([{state:'captured', actualUsd6:'100000000000000001', maximumUsd6:'100000000000000099'}, {state:'captured', actualUsd6:'2', maximumUsd6:'20'}]);
  assert.equal(result.chargedUsd6, '100000000000000003');
  assert.equal(result.pending, 0);
});
test('pending reservations and reconciliation are never counted as charges', () => {
  assert.deepEqual(chatBillingSummary([{state:'captured',actualUsd6:'21',maximumUsd6:'90'}, {state:'reconciliation_pending',actualUsd6:null,maximumUsd6:'120'}, {state:'released',actualUsd6:'0',maximumUsd6:'100'}]), {chargedUsd6:'21',reservedUsd6:'120',pending:1,unknown:false});
  assert.deepEqual(chatBillingSummary([{state:'held',actualUsd6:null,maximumUsd6:null}]), {chargedUsd6:'0',reservedUsd6:'0',pending:1,unknown:true});
});
test('send preferences preserve IME, multiline and modifier behavior', () => {
  const enter = { key:'Enter', shiftKey:false, altKey:false, ctrlKey:false, metaKey:false, isComposing:false };
  assert.equal(shouldSubmitChatKey(enter, 'enter'), true);
  assert.equal(shouldSubmitChatKey(enter, 'modifier'), false);
  for (const modifier of ['ctrlKey', 'metaKey']) assert.equal(shouldSubmitChatKey({...enter,[modifier]:true}, 'modifier'), true);
  for (const blocker of ['isComposing', 'shiftKey', 'altKey']) for (const preference of ['enter','modifier']) assert.equal(shouldSubmitChatKey({...enter,ctrlKey:true,[blocker]:true}, preference), false);
  assert.equal(shouldSubmitChatKey({...enter,key:'a'}, 'enter'), false);
  assert.equal(validChatSendKey('auto'), false);
  assert.equal(validChatSendKey('modifier'), true);
});
