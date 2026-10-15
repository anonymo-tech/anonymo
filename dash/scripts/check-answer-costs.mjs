import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerCosts,
  formatAnswerUsd6,
  sumAnswerCosts,
} from '../components/dashboard/answer-costs.ts';

const answer = (maximumUsd6, actualUsd6) => ({
  live: { billing: { maximumUsd6, actualUsd6 } },
});

void test('formats exact USD6 amounts with at least four decimal places', () => {
  for (const [value, expected] of [
    ['0', '$0.0000'], ['1', '$0.000001'], ['99', '$0.000099'],
    ['100', '$0.0001'], ['101', '$0.000101'], ['9999', '$0.009999'],
    ['12300', '$0.0123'], ['20000', '$0.0200'], ['1000000', '$1.0000'],
    ['9007199254740993', '$9007199254.740993'],
  ]) assert.equal(formatAnswerUsd6(value), expected);
});

void test('invalid or unknown values are never formatted as zero', () => {
  for (const value of [null, undefined, '', '-1', '0.1', '1e6', 'NaN', ' 1', '01', 1])
    assert.equal(formatAnswerUsd6(value), null);
});

void test('requires a visible quote and distinguishes unsettled from a settled zero', () => {
  assert.equal(answerCosts(), null);
  assert.equal(answerCosts({ maximumUsd6: null, actualUsd6: null }), null);
  assert.equal(answerCosts({ maximumUsd6: null, actualUsd6: '1' }), null);
  assert.deepEqual(answerCosts({ maximumUsd6: '20000', actualUsd6: null }), {
    quoted: '$0.0200', settled: null,
  });
  assert.deepEqual(answerCosts({ maximumUsd6: '20000', actualUsd6: '0' }), {
    quoted: '$0.0200', settled: '$0.0000',
  });
  assert.deepEqual(answerCosts({ maximumUsd6: '20000', actualUsd6: '12300' }), {
    quoted: '$0.0200', settled: '$0.0123',
  });
  assert.equal(answerCosts({ maximumUsd6: 'invalid', actualUsd6: '1' }), null);
  assert.equal(answerCosts({ maximumUsd6: '1', actualUsd6: undefined }), null);
});

void test('sums USD6 with BigInt before formatting, including zero and tiny settlements', () => {
  assert.deepEqual(sumAnswerCosts([answer('20000', '12300'), answer('20000', '1')]), {
    quoted: '$0.0400', settled: '$0.012301',
  });
  assert.deepEqual(sumAnswerCosts([answer('1', '0'), answer('1', '0')]), {
    quoted: '$0.000002', settled: '$0.0000',
  });
  assert.deepEqual(sumAnswerCosts([
    answer('9007199254740993', '9007199254740993'), answer('7', '7'),
  ]), { quoted: '$9007199254.7410', settled: '$9007199254.7410' });
  assert.deepEqual(sumAnswerCosts([
    answer('9999999999999999', '9999999999999999'), answer('1', '1'),
  ]), { quoted: '$10000000000.0000', settled: '$10000000000.0000' });
});

void test('suppresses single, sample, hidden, missing and partially settled totals', () => {
  for (const answers of [
    [], [answer('2', '1')], [{}, {}],
    [answer('2', '1'), {}],
    [answer('2', '1'), { live: {} }],
    [answer('2', '1'), answer('2', null)],
    [answer('2', '1'), answer(null, '1')],
    [answer('2', '1'), answer('2', undefined)],
    [answer('2', '1'), answer('invalid', '1')],
    [answer('2', '1'), answer('2', '-1')],
  ]) assert.equal(sumAnswerCosts(answers), null);
});
