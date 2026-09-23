import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { entropyToMnemonic, validateMnemonic } from '@scure/bip39';
import bs58 from 'bs58';
import {
  MAX_PROMPT_LENGTH,
  REDACTION,
  redactFindings,
  scanPrompt,
} from '../lib/guards/index.ts';
import { mnemonicWordlists } from '../lib/guards/wordlists.ts';
import { handleGuardRequest } from '../lib/guards/worker.ts';

const syntheticBytes = (label, size) => {
  const bytes = Buffer.concat(
    [0, 1].map((part) =>
      createHash('sha256')
        .update(`conclave-guard-fixture-v1:${label}:${part}`)
        .digest(),
    ),
  );
  return new Uint8Array(bytes.subarray(0, size));
};
const mnemonic = (language = 'english', size = 16, label = 1) =>
  entropyToMnemonic(syntheticBytes(label, size), mnemonicWordlists[language]);
const blocks = (result) =>
  result.findings.filter((finding) => finding.severity === 'block');
const containsRange = (result, start, end, type) =>
  result.findings.some(
    (finding) =>
      finding.type === type && finding.start <= start && finding.end >= end,
  );

void test('checksums and all ten wordlists support every BIP-39 word count', () => {
  assert.equal(Object.keys(mnemonicWordlists).length, 10);
  for (const language of Object.keys(mnemonicWordlists)) {
    for (const size of [16, 20, 24, 28, 32]) {
      const phrase = mnemonic(language, size, `${language}:${size}`).normalize(
        'NFC',
      );
      const text = `Quoted material: «${phrase}» end.`;
      assert.ok(
        containsRange(scanPrompt(text), 18, 18 + phrase.length, 'mnemonic'),
        `Supported phrase not fully covered: ${language}/${size}`,
      );
    }
  }
});
