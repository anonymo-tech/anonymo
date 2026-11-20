// The coin's contract address: a copyable chip in the public site header (every public page, no scrolling needed)
// and a copyable field on the dashboard overview.
//
// To publish it at launch, set NEXT_PUBLIC_ANONYMO_COIN_ADDRESS on the dash service and redeploy (it is read at build
// time), or paste it into COIN_ADDRESS below. Until one is set, the field says it is announced at launch. Only a
// well-formed EVM address is shown, so a typo shows nothing rather than a wrong address.

/** Paste the contract address here if you are not using the environment variable. */
export const COIN_ADDRESS = '';
export const COIN_CHAIN = 'Robinhood Chain';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The address to show, or null while there is none (or what was set is not an EVM address). */
export function coinAddress(fromEnv: string | undefined = process.env.NEXT_PUBLIC_ANONYMO_COIN_ADDRESS, fallback: string = COIN_ADDRESS): string | null {
  const value = (fromEnv ?? '').trim() || fallback.trim();
  return EVM_ADDRESS.test(value) ? value : null;
}

/** 0x1234…abcd, for narrow screens. The full address is always what gets copied. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
