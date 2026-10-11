import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAddress,
  findProgramAddress,
  treasuryUsdcTokenAccount,
} from '../server/solana/associated-token.ts';
import {
  SOLANA_NETWORKS,
  SolanaError,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from '../server/solana/validation.ts';

// Public mainnet treasury wallet address only; no key material is used here.
const TREASURY_WALLET = 'HqHHKDhPj3rcxjqYzvt4Tw1Cv2HUteSYJkwKrENjpDnQ';
const MAINNET_USDC = SOLANA_NETWORKS['mainnet-beta'].usdcMint;
// Cross-check pin. `spl-token address --owner ... --token ... --verbose`
// fetches the mint account over RPC to pick the token program and fails
// offline, so the pin was produced once by the independent offline CLI:
//   solana find-program-derived-address ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL \
//     pubkey:<treasury wallet> pubkey:<TOKEN_PROGRAM> pubkey:<mainnet USDC mint>
// (solana-cli 3.1.10, no network). Derived offline; not verified on chain.
const TREASURY_USDC_ATA = 'GGyu8CW7C2t2N51MAPbb9KFw8VaskixcAQ4p5TgHa9iT';

const rejected = (run, code = 'invalid_input') => {
  assert.throws(run, (error) => {
    assert.ok(error instanceof SolanaError);
    assert.equal(error.code, code);
    return true;
  });
};

void test('derives the treasury mainnet USDC ATA matching the offline CLI', () => {
  assert.equal(
    associatedTokenAddress({
      owner: TREASURY_WALLET,
      mint: MAINNET_USDC,
      tokenProgram: TOKEN_PROGRAM,
    }),
    TREASURY_USDC_ATA,
  );
  assert.equal(
    treasuryUsdcTokenAccount('mainnet-beta', TREASURY_WALLET),
    TREASURY_USDC_ATA,
  );
  assert.equal(
    ASSOCIATED_TOKEN_PROGRAM,
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  );
});

void test('matches a second offline CLI vector for a different owner', () => {
  // Same offline CLI command with the System Program id as the owner seed.
  assert.equal(
    associatedTokenAddress({
      owner: '11111111111111111111111111111111',
      mint: MAINNET_USDC,
      tokenProgram: TOKEN_PROGRAM,
    }),
    'HJt8Tjdsc9ms9i4WCZEzhzr4oyf3ANcdzXrNdLPFqm3M',
  );
});

void test('the derived address is a valid off-curve 32-byte key', () => {
  const bytes = bs58.decode(TREASURY_USDC_ATA);
  assert.equal(bytes.length, 32);
  const derived = findProgramAddress(
    [TREASURY_WALLET, TOKEN_PROGRAM, MAINNET_USDC].map((key) =>
      bs58.decode(key),
    ),
    ASSOCIATED_TOKEN_PROGRAM,
  );
  assert.equal(derived.address, TREASURY_USDC_ATA);
  assert.ok(derived.bump >= 0 && derived.bump <= 255);
});

void test('devnet and Token-2022 inputs derive different accounts', () => {
  const devnet = treasuryUsdcTokenAccount('devnet', TREASURY_WALLET);
  const token2022 = associatedTokenAddress({
    owner: TREASURY_WALLET,
    mint: MAINNET_USDC,
    tokenProgram: TOKEN_2022_PROGRAM,
  });
  assert.notEqual(devnet, TREASURY_USDC_ATA);
  assert.notEqual(token2022, TREASURY_USDC_ATA);
  assert.notEqual(devnet, token2022);
});

void test('rejects an invalid owner', () => {
  const input = { mint: MAINNET_USDC, tokenProgram: TOKEN_PROGRAM };
  rejected(() => associatedTokenAddress({ ...input, owner: '' }));
  rejected(() =>
    associatedTokenAddress({ ...input, owner: 'not-base58-0OIl' }),
  );
  rejected(() =>
    associatedTokenAddress({ ...input, owner: TREASURY_WALLET.slice(0, 30) }),
  );
  rejected(() =>
    associatedTokenAddress({
      ...input,
      owner: bs58.encode(new Uint8Array(33).fill(7)),
    }),
  );
  rejected(() => associatedTokenAddress({ ...input, owner: 42 }));
  rejected(() => treasuryUsdcTokenAccount('mainnet-beta', undefined));
});

void test('rejects an invalid mint, token program or cluster', () => {
  rejected(() =>
    associatedTokenAddress({
      owner: TREASURY_WALLET,
      mint: 'EPjF',
      tokenProgram: TOKEN_PROGRAM,
    }),
  );
  rejected(() =>
    associatedTokenAddress({
      owner: TREASURY_WALLET,
      mint: MAINNET_USDC,
      tokenProgram: ASSOCIATED_TOKEN_PROGRAM,
    }),
  );
  rejected(
    () => treasuryUsdcTokenAccount('testnet', TREASURY_WALLET),
    'invalid_configuration',
  );
  rejected(() => findProgramAddress([], ASSOCIATED_TOKEN_PROGRAM));
  rejected(() =>
    findProgramAddress([new Uint8Array(33)], ASSOCIATED_TOKEN_PROGRAM),
  );
});

void test('derivation is deterministic', () => {
  const results = new Set(
    Array.from({ length: 8 }, () =>
      treasuryUsdcTokenAccount('mainnet-beta', TREASURY_WALLET),
    ),
  );
  assert.deepEqual([...results], [TREASURY_USDC_ATA]);
  const first = findProgramAddress(
    [bs58.decode(TREASURY_WALLET)],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  const second = findProgramAddress(
    [bs58.decode(TREASURY_WALLET)],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  assert.deepEqual(first, second);
});
