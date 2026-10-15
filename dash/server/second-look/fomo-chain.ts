import { createHash } from 'node:crypto';
import type { FomoSource } from '../../lib/second-look/fomo.ts';
import { address } from '../solana/validation.ts';
import { createTokenProviders, type TokenProviders } from './providers.ts';
import { decodeMintAccount } from './token-facts.ts';

const cache = new Map<string, { expires: number; source: FomoSource }>();
/** Fixed public RPC, read-only methods, no account, key, paid index or simulation.
 * Validate mainnet and decode bytes rather than trusting a token's name/symbol. */
export async function readFomoMintFacts(mint: string, signal?: AbortSignal, now=new Date(), injected?: Pick<TokenProviders,'genesis'|'mint'>): Promise<FomoSource> {
  address(mint);
  const hit = !injected ? cache.get(mint) : null;
  if (signal?.aborted) throw new DOMException('Cancelled','AbortError');
  if (hit && hit.expires > now.getTime()) return structuredClone(hit.source);
  const source: FomoSource = {
    id:'chain-mint', label:'Solana mint controls', url:'https://explorer.solana.com/address/'+mint,
    fetchedAt:now.toISOString(), observedAt:null, state:'unavailable', data:null,
    note:'The public chain check was unavailable. No authority state or safety conclusion has been inferred.',
  };
  const providers = injected ?? createTokenProviders({ enabled:true, rpcUrl:'https://api.mainnet-beta.solana.com', dex:false, rug:false, evidence:false, simulation:false, claims:false, deep:false, freeDailyGlobalLimit:0 });
  try {
    await providers.genesis(signal);
    const raw = await providers.mint(mint,signal);
    const checks = decodeMintAccount(raw,mint,now.getTime()).filter(c=>[1,2].includes(c.id));
    source.state='partial';
    source.observedAt=now.toISOString();
    source.note='Mint bytes checked at finalized commitment on Solana mainnet. This verifies the displayed mint state through a public RPC, not ownership, trading skill, holder identities, sellability or investment safety. Unknown extensions retain their limitations.';
    source.data={mint,cluster:'mainnet-beta',method:'finalized-mint-bytes',checks,rawResponse:raw,sha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex')};
    if (!injected) {
      if (cache.size>=64) cache.delete(cache.keys().next().value!);
      cache.set(mint,{expires:now.getTime()+30000,source:structuredClone(source)});
    }
  } catch {
    if(signal?.aborted) throw new DOMException('Cancelled','AbortError');
  }
  return source;
}
