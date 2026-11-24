import { associatedTokenAddress } from '../../server/solana/associated-token.ts';
import { address, TOKEN_PROGRAM } from '../../server/solana/validation.ts';
import { musdToUsdString, parseUsd } from './money.ts';
import type { SolanaInstructions } from './types.ts';

/** USDC and USDT both have six decimals, so micro-USD is also the exact token amount in base units. */
export function solanaPayUrl(
  instructions: SolanaInstructions,
  mint: string,
  amount: string,
  message = 'Add funds to your Anonymo key',
): string | null {
  const musd = typeof amount === 'string' ? parseUsd(amount) : null;
  if (!musd || typeof message !== 'string' || !message.trim() || /\p{Cc}/u.test(message)) return null;
  try {
    if (instructions.cluster !== 'mainnet-beta' && instructions.cluster !== 'devnet') return null;
    const tokens = instructions.tokens.filter(t => t.mint === mint);
    const token = tokens[0];
    if (tokens.length !== 1 || (token.symbol !== 'USDC' && token.symbol !== 'USDT')) return null;
    if (instructions.tokens.some(t => t !== token && t.symbol === token.symbol)) return null;
    const owner = address(instructions.recipient_wallet);
    const reference = address(instructions.reference);
    const account = address(token.token_account);
    // Wallets derive the destination from the owner and mint. It must be the account the watcher polls.
    if (associatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM }) !== account) return null;
    if (new Set([owner, account, mint, reference, TOKEN_PROGRAM]).size !== 5) return null;
    return `solana:${owner}?amount=${musdToUsdString(musd)}&spl-token=${mint}&reference=${reference}&label=Anonymo&message=${encodeURIComponent(message)}`;
  } catch {
    return null;
  }
}
