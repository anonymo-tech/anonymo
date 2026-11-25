import { createPublicClient, createWalletClient, custom, defineChain, pad, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import { evmNetwork } from './chains';
import type { CreatorClaim, CreatorContracts } from './creators';
import { connectWallet, ensureChain, injectedProvider, type Eip1193Provider } from './wallet';

const payoutsAbi = parseAbi([
  'function usdg() view returns (address)',
  'function tip(address creator, uint256 amount)',
  'function claim(uint256 week, uint256 amount, (bytes32 hash, uint256 sum)[] proof)',
]);
const boostsAbi = parseAbi([
  'function nymo() view returns (address)',
  'function boost(bytes32 creatorId, uint256 amount)',
  'function unlock(bytes32 creatorId, uint256 amount)',
]);
const votesAbi = parseAbi(['function vote(uint8 ballot, bytes32 option)']);
const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export function creatorProvider() {
  const provider = injectedProvider();
  if (!provider) throw new Error('Open this page in a browser with a wallet.');
  return provider;
}

export async function signCreatorRequest(provider: Eip1193Provider, wallet: Address, body: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const time = Math.floor(Date.now() / 1000);
  const signature = await provider.request({ method: 'personal_sign', params: [stringToHex(`anonymo:${time}:${digest}`), wallet] });
  return `${wallet}:${time}:${signature}`;
}

async function session(contracts: CreatorContracts, address: Address) {
  const provider = creatorProvider();
  const account = await connectWallet(provider);
  const network = evmNetwork('rhc', { chain_id: contracts.chainId, rpc_url: contracts.rpc });
  await ensureChain(provider, network);
  const chain = defineChain({ id: network.chainId, name: network.name, nativeCurrency: network.nativeCurrency, rpcUrls: { default: { http: [network.rpcUrl] } } });
  const transport = custom(provider);
  const pub = createPublicClient({ chain, transport });
  const signer = createWalletClient({ chain, transport, account });
  const code = await pub.getCode({ address });
  if (!code || code === '0x') throw new Error('The contract is unavailable on this chain.');
  async function confirm(hash: Hex) {
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error('The transaction reverted.');
    return hash;
  }
  async function approve(token: Address, amount: bigint) {
    const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, address] });
    if (allowance >= amount) return;
    const { request } = await pub.simulateContract({ address: token, account, abi: erc20Abi, functionName: 'approve', args: [address, amount] });
    await confirm(await signer.writeContract(request));
  }
  return { account, pub, signer, confirm, approve };
}

export async function tipCreator(contracts: CreatorContracts, wallet: Address, amount: bigint) {
  const address = contracts.payouts;
  if (!address) throw new Error('Tips are unavailable.');
  const { pub, signer, account, confirm, approve } = await session(contracts, address);
  const token = await pub.readContract({ address, abi: payoutsAbi, functionName: 'usdg' });
  if (token.toLowerCase() !== contracts.usdg.toLowerCase()) throw new Error('The USDG contract does not match the payout contract.');
  await approve(token, amount);
  const { request } = await pub.simulateContract({ address, account, abi: payoutsAbi, functionName: 'tip', args: [wallet, amount] });
  return confirm(await signer.writeContract(request));
}

export async function claimCreator(contracts: CreatorContracts, claim: CreatorClaim) {
  const address = contracts.payouts;
  if (!address || !claim.tx) throw new Error('This root is waiting to be posted.');
  const { pub, signer, account, confirm } = await session(contracts, address);
  if (account.toLowerCase() !== claim.wallet.toLowerCase()) throw new Error('Connect the payout wallet first.');
  const proof = claim.proof.map(({ hash, sum }) => ({ hash, sum: BigInt(sum) }));
  const { request } = await pub.simulateContract({ address, account, abi: payoutsAbi, functionName: 'claim', args: [BigInt(claim.epoch), BigInt(claim.amount), proof] });
  return confirm(await signer.writeContract(request));
}

export async function boostCreator(contracts: CreatorContracts, wallet: Address, amount: bigint, unlock: boolean) {
  const address = contracts.boosts;
  if (!address) throw new Error('Boosts are unavailable.');
  const { pub, signer, account, confirm, approve } = await session(contracts, address);
  if (!unlock) {
    const token = await pub.readContract({ address, abi: boostsAbi, functionName: 'nymo' });
    await approve(token, amount);
  }
  const { request } = await pub.simulateContract({
    address, account, abi: boostsAbi, functionName: unlock ? 'unlock' : 'boost', args: [pad(wallet, { size: 32 }), amount],
  });
  return confirm(await signer.writeContract(request));
}

export async function voteForCreatorOption(contracts: CreatorContracts, ballot: number, option: Hex) {
  const address = contracts.votes;
  if (!address) throw new Error('Voting is unavailable.');
  const { pub, signer, account, confirm } = await session(contracts, address);
  const { request } = await pub.simulateContract({ address, account, abi: votesAbi, functionName: 'vote', args: [ballot, option] });
  return confirm(await signer.writeContract(request));
}
