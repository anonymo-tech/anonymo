import { rpcTransport } from "./rpc-transport.ts"; // RPC1
import { RECEIPT_ROOTS_POST_ABI } from "../receipts/roots.ts";
import {
  BlockNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  hashTypedData,
  parseSignature,
  recoverTypedDataAddress,
  size,
  type Abi,
  type Hex,
  type PublicClient,
  type TypedDataDefinition,
  type WalletClient,
  type Chain,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../config.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import {
  CallPayAbi,
  CreditsAbi,
  CreatorPayoutsAbi,
  ReferralsAbi,
  ProviderBondAbi,
  ReceiptAnchorAbi,
  RoyaltyAbi,
  erc20Abi,
} from "./abis.ts";

export type ContractName = "credits" | "callPay" | "providerBond" | "receiptAnchor" | "royalty";
export const CONTRACT_ABIS: Record<ContractName, Abi> = {
  credits: CreditsAbi as unknown as Abi,
  callPay: CallPayAbi as unknown as Abi,
  providerBond: ProviderBondAbi as unknown as Abi,
  receiptAnchor: ReceiptAnchorAbi as unknown as Abi,
  royalty: RoyaltyAbi as unknown as Abi,
};

export type DecodedLog = { contract: ContractName; event: string; args: Record<string, unknown>; txHash: Hex; logIndex: number; blockNumber: bigint };
const transferEvent = { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] } as const;
export type CallPayment = { nonce: Hex; payer: Hex; amount: bigint; blockNumber: bigint; confirmations: number; logIndex: number };
const erc1271Abi = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ type: "bytes4" }] }] as const;

// EIP-3009 surface of USDG: both signature overloads exist on Robinhood Chain (v,r,s and bytes).
const usdg3009Abi = [
  { type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [] },
  { type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [] },
] as const;

export type Role = "router" | "settlement" | "anchorer" | "slasher" | "faucet" | "facilitator" | "creatorPayouts";

export class ChainService {
  readonly chain: Chain;
  readonly client: PublicClient;
  private wallets = new Map<Role, WalletClient>();

  constructor(private cfg: Config) {
    this.chain = defineChain({
      id: cfg.chain.id,
      name: cfg.chain.id === 4663 ? "Robinhood Chain" : `Chain ${cfg.chain.id}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.chain.publicRpcUrl] } },
    });
    // cacheTime 0: viem otherwise caches eth_blockNumber for 4s, which hides fresh blocks from the
    // indexer and payment checks (RHC produces ~10 blocks per second).
    this.client = createPublicClient({ chain: this.chain, cacheTime: 0, pollingInterval: 250, transport: rpcTransport(cfg.chain, { retryCount: 2, timeout: 15_000 }) });
    const keys: Record<Role, Hex | undefined> = {
      router: cfg.chain.routerKey,
      settlement: cfg.chain.settlementKey,
      anchorer: cfg.chain.anchorerKey,
      slasher: cfg.chain.slasherKey,
      faucet: cfg.chain.faucetKey,
      creatorPayouts: cfg.creators.payoutSigner,
      facilitator: cfg.facilitator.relayKey, // v6 F: pays relay gas and nothing else
    };
    for (const [role, key] of Object.entries(keys) as [Role, Hex | undefined][]) {
      if (key) this.wallets.set(role, createWalletClient({ account: privateKeyToAccount(key), chain: this.chain, transport: rpcTransport(cfg.chain) }));
    }
  }

  address(name: ContractName): Hex | undefined {
    return this.cfg.chain[name] as Hex | undefined;
  }

  require(name: ContractName): Hex {
    const a = this.address(name);
    if (!a) fail(503, `The ${name} contract is not configured on this router.`, "chain_unconfigured");
    return a;
  }

  wallet(role: Role): WalletClient & { account: Account } {
    const w = this.wallets.get(role);
    if (!w) fail(503, `No ${role} signing key is configured.`, "chain_unconfigured");
    return w as WalletClient & { account: Account };
  }

  roleAddress(role: Role): Hex | undefined {
    return this.wallets.get(role)?.account?.address;
  }

  status() {
    const contracts = Object.fromEntries((Object.keys(CONTRACT_ABIS) as ContractName[]).map((n) => [n, this.address(n) ?? null]));
    return {
      chain_id: this.cfg.chain.id,
      public_rpc: this.cfg.chain.publicRpcUrl,
      explorer: this.cfg.chain.explorerUrl,
      usdg: this.cfg.chain.usdg,
      contracts,
      signers: Object.fromEntries([...this.wallets.entries()].filter(([r]) => r !== "faucet").map(([r, w]) => [r, w.account?.address])),
    };
  }

  async blockNumber() {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  private async send(role: Role, to: Hex, abi: Abi, functionName: string, args: unknown[], confirmations = 1) {
    const w = this.wallet(role);
    const { request } = await this.client.simulateContract({ account: w.account, address: to, abi, functionName, args } as never);
    const hash = await w.writeContract(request as never);
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations, timeout: 120_000 });
    if (receipt.status !== "success") fail(502, `Transaction ${hash} reverted.`, "chain_reverted");
    return { hash, receipt };
  }

  async postCreatorRoot(address: Hex, week: bigint, root: Hex, total: bigint) {
    // Recheck funding immediately before simulating the write.
    const funded = await this.client.readContract({ address, abi: CreatorPayoutsAbi, functionName: "funded", args: [week] });
    if (funded !== total) throw new Error("Creator payout funding does not match the root total.");
    const { hash } = await this.oneAtATime("creatorPayouts", () =>
      this.send("creatorPayouts", address, CreatorPayoutsAbi, "postRoot", [week, root], this.cfg.chain.confirmations));
    return hash;
  }

  async registerCreatorReferral(address: Hex, inviterHash: Hex) {
    const { hash } = await this.oneAtATime("creatorPayouts", () =>
      this.send("creatorPayouts", address, ReferralsAbi, "register", [inviterHash], this.cfg.chain.confirmations));
    return hash;
  }

  decode(contract: ContractName, logEntry: { address: Hex; topics: Hex[]; data: Hex; transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null }): DecodedLog | null {
    try {
      const d = decodeEventLog({ abi: CONTRACT_ABIS[contract], topics: logEntry.topics as [Hex, ...Hex[]], data: logEntry.data });
      return {
        contract,
        event: String(d.eventName),
        args: (d.args ?? {}) as Record<string, unknown>,
        txHash: logEntry.transactionHash!,
        logIndex: logEntry.logIndex!,
        blockNumber: logEntry.blockNumber!,
      };
    } catch {
      return null;
    }
  }

  /** All configured-contract events in [from, to]. */
  async logs(from: bigint, to: bigint): Promise<DecodedLog[]> {
    const names = (Object.keys(CONTRACT_ABIS) as ContractName[]).filter((n) => this.address(n));
    if (!names.length) return [];
    const byAddress = new Map(names.map((n) => [this.address(n)!.toLowerCase(), n]));
    const raw = await this.client.getLogs({ address: names.map((n) => this.address(n)!), fromBlock: from, toBlock: to });
    const out: DecodedLog[] = [];
    for (const l of raw) {
      const name = byAddress.get(l.address.toLowerCase());
      if (!name) continue;
      const d = this.decode(name, l as never);
      if (d) out.push(d);
    }
    return out;
  }

  /** Hash of the canonical block at `n`, or null when the node does not have that block. */
  async blockHashAt(n: bigint): Promise<Hex | null> {
    try {
      return (await this.client.getBlock({ blockNumber: n })).hash;
    } catch (err) {
      if (err instanceof BlockNotFoundError) return null;
      throw err;
    }
  }

  // ---- 402 per-call payments -------------------------------------------------------------

  /** Read every CallPay payment in a transaction (the X-Payment header). Pending until confirmed. */
  async readCallPayments(txHash: Hex): Promise<CallPayment[] | { pending: true; confirmations: number }> {
    const callPay = this.require("callPay");
    const receipt = await this.client.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!receipt) return { pending: true, confirmations: 0 };
    if (receipt.status !== "success") fail(402, "This payment transaction failed on-chain, so nothing was paid.", "payment_failed");
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    const confirmations = Number(head - receipt.blockNumber + 1n);
    const out: CallPayment[] = [];
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== callPay.toLowerCase()) continue;
      const d = this.decode("callPay", l as never);
      if (d?.event === "Paid") out.push({ nonce: d.args.nonce as Hex, payer: d.args.payer as Hex, amount: d.args.amount as bigint, blockNumber: receipt.blockNumber, confirmations, logIndex: d.logIndex });
    }
    if (!out.length) fail(402, "This transaction does not contain a CallPay payment.", "payment_not_found");
    if (confirmations < this.cfg.chain.confirmations) return { pending: true, confirmations };
    return out;
  }

  /** @deprecated single-payment view kept for callers that only need the first payment. */
  async readCallPayment(txHash: Hex): Promise<CallPayment | { pending: true; confirmations: number }> {
    const r = await this.readCallPayments(txHash);
    return Array.isArray(r) ? r[0] : r;
  }

  private domainCache: { name: string; version: string } | null = null;
  /** USDG's EIP-712 domain, read from the token (ERC-5267) with the configured values as fallback. */
  async usdgDomain(): Promise<{ name: string; version: string }> {
    if (this.domainCache) return this.domainCache;
    try {
      const d = (await this.client.readContract({
        address: this.cfg.chain.usdg,
        abi: [{ type: "function", name: "eip712Domain", stateMutability: "view", inputs: [], outputs: [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }] }],
        functionName: "eip712Domain",
      })) as readonly unknown[];
      this.domainCache = { name: String(d[1]), version: String(d[2]) };
    } catch {
      this.domainCache = { ...this.cfg.chain.usdgDomain };
    }
    return this.domainCache;
  }

  /** Relay an EIP-3009 ReceiveWithAuthorization through CallPay.payWithAuthorization (router pays gas). */
  async payWithAuthorization(a: { nonce: Hex; amount: bigint; expiry: bigint; from: Hex; validAfter: bigint; validBefore: bigint; signature: Hex }) {
    const callPay = this.require("callPay");
    const { hash } = await this.send("router", callPay, CallPayAbi as unknown as Abi, "payWithAuthorization", [a.nonce, a.amount, a.expiry, a.from, a.validAfter, a.validBefore, a.signature]);
    return hash;
  }

  /** Whether `authorizer` already used (or cancelled) this EIP-3009 nonce on USDG. */
  async authorizationUsed(authorizer: Hex, nonce: Hex): Promise<boolean> {
    return (await this.client.readContract({ address: this.cfg.chain.usdg, abi: usdg3009Abi, functionName: "authorizationState", args: [authorizer, nonce] })) as boolean;
  }

  private relayTails = new Map<Role, Promise<unknown>>();

  private oneAtATime<T>(role: Role, work: () => Promise<T>) {
    const run = (this.relayTails.get(role) ?? Promise.resolve()).then(work);
    this.relayTails.set(role, run.catch(() => undefined));
    return run;
  }

  /** x402 settlement: relay the payer's signed USDG transferWithAuthorization straight to `to` (no contract in
   *  between; the relaying role, the router or the facilitator's relay key, only pays gas). Relays run one at a time
   *  per process and role so a key's nonce never races. Resolves once the transfer of exactly `value` is mined with
   *  CHAIN_CONFIRMATIONS on top, with the gas it used. */
  async transferWithAuthorization(a: { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex; signature: Hex }, role: "router" | "facilitator" = "router"): Promise<{ hash: Hex; blockNumber: bigint; gasUsed?: bigint; effectiveGasPrice?: bigint }> {
    const head = [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce] as const;
    let args: unknown[] = [...head, a.signature];
    if (size(a.signature) === 65) {
      const { r, s, yParity } = parseSignature(a.signature);
      args = [...head, 27 + (yParity ?? 0), r, s];
    }
    const { hash, receipt } = await this.oneAtATime(role,
      () => this.send(role, this.cfg.chain.usdg, usdg3009Abi as unknown as Abi, "transferWithAuthorization", args));
    const moved = receipt.logs.some((l) => {
      if (l.address.toLowerCase() !== this.cfg.chain.usdg.toLowerCase()) return false;
      try {
        const d = decodeEventLog({ abi: [transferEvent], topics: l.topics as [Hex, ...Hex[]], data: l.data });
        return d.args.from.toLowerCase() === a.from.toLowerCase() && d.args.to.toLowerCase() === a.to.toLowerCase() && d.args.value === a.value;
      } catch {
        return false;
      }
    });
    if (!moved) fail(502, `Transaction ${hash} did not transfer the authorized USDG.`, "chain_reverted");
    if (this.cfg.chain.confirmations > 1) await this.client.waitForTransactionReceipt({ hash, confirmations: this.cfg.chain.confirmations, timeout: 30_000 });
    return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice };
  }

  /** Native-gas balance of an address, in wei (the facilitator's relay floor). */
  async nativeBalance(of: Hex): Promise<bigint> {
    return this.client.getBalance({ address: of });
  }

  /** The chain's current gas price, in wei. */
  async gasPrice(): Promise<bigint> {
    return this.client.getGasPrice();
  }

  /** Whether `signature` over `typedData` is valid for `wallet`: ECDSA for EOAs, ERC-1271 for smart wallets.
   *  An off-chain pre-check only; the contract verifies every authorization itself. */
  async verifyWalletSignature(wallet: Hex, typedData: TypedDataDefinition, signature: Hex): Promise<boolean> {
    try {
      if ((await recoverTypedDataAddress({ ...typedData, signature } as never)).toLowerCase() === wallet.toLowerCase()) return true;
    } catch {
      // not a plain ECDSA signature: may still be a smart wallet's
    }
    try {
      const code = await this.client.getCode({ address: wallet });
      if (!code || code === "0x") return false;
      const magic = await this.client.readContract({ address: wallet, abi: erc1271Abi, functionName: "isValidSignature", args: [hashTypedData(typedData as never), signature] });
      return magic === "0x1626ba7e";
    } catch {
      return false;
    }
  }

  /** Decode every log in a receipt that belongs to a configured Anonymo contract. */
  decodeReceipt(logs: { address: Hex; topics: Hex[]; data: Hex; transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null }[]): DecodedLog[] {
    const byAddress = new Map((Object.keys(CONTRACT_ABIS) as ContractName[]).filter((n) => this.address(n)).map((n) => [this.address(n)!.toLowerCase(), n]));
    const out: DecodedLog[] = [];
    for (const l of logs) {
      const name = byAddress.get(l.address.toLowerCase());
      const d = name ? this.decode(name, l) : null;
      if (d) out.push(d);
    }
    return out;
  }

  // ---- Receipts -------------------------------------------------------------------------

  async blockTimestamp(): Promise<number> {
    return Number((await this.client.getBlock({ blockTag: "latest" })).timestamp);
  }

  async anchor(root: Hex, fromTs: number, toTs: number, count: number) {
    const a = this.require("receiptAnchor");
    const { hash, receipt } = await this.send("anchorer", a, ReceiptAnchorAbi as unknown as Abi, "anchor", [root, BigInt(fromTs), BigInt(toTs), count]);
    let index: bigint | null = null;
    for (const l of receipt.logs) {
      const d = l.address.toLowerCase() === a.toLowerCase() ? this.decode("receiptAnchor", l as never) : null;
      if (d?.event === "Anchored") index = d.args.index as bigint;
    }
    return { hash, index };
  }

  /** ReceiptRoots.post(hour, root) as the anchorer (Anonymo, rollout A3). */
  async postReceiptRoot(hour: bigint, root: Hex): Promise<{ txHash: string }> {
    const a = this.cfg.chain.anonymoReceiptRoots;
    if (!a) fail(503, "The ReceiptRoots contract is not configured on this router.", "chain_unconfigured");
    const { hash } = await this.send("anchorer", a, RECEIPT_ROOTS_POST_ABI as unknown as Abi, "post", [hour, root]);
    return { txHash: hash };
  }

  async anchorOnChain(index: number): Promise<{ root: Hex; fromTs: bigint; toTs: bigint; count: number } | null> {
    const a = this.address("receiptAnchor");
    if (!a) return null;
    const r = (await this.client.readContract({ address: a, abi: ReceiptAnchorAbi, functionName: "anchors", args: [BigInt(index)] })) as [Hex, bigint, bigint, number];
    return r[0] === "0x0000000000000000000000000000000000000000000000000000000000000000" ? null : { root: r[0], fromTs: r[1], toTs: r[2], count: Number(r[3]) };
  }

  async registerSigningKey(keyId: string, publicKeyHex: string, validFrom: Date) {
    const a = this.require("receiptAnchor");
    return this.send("anchorer", a, ReceiptAnchorAbi as unknown as Abi, "registerSigningKey", [
      `0x${keyId}` as Hex,
      `0x${publicKeyHex}` as Hex,
      BigInt(Math.floor(validFrom.getTime() / 1000)),
    ]);
  }

  async signingKeyOnChain(keyId: string) {
    const a = this.address("receiptAnchor");
    if (!a) return null;
    const r = (await this.client.readContract({ address: a, abi: ReceiptAnchorAbi, functionName: "signingKeys", args: [`0x${keyId}` as Hex] })) as [Hex, bigint, bigint];
    return BigInt(r[0]) === 0n ? null : { publicKey: r[0], validFrom: r[1], revokedAt: r[2] };
  }

  // ---- Settlement -----------------------------------------------------------------------

  get devFaucet() {
    return this.wallets.has("faucet");
  }

  /** Local chain only (the mock USDG has an open mint): mint, approve and deposit to a key hash. */
  async faucetDeposit(chainKeyHash: Hex, units: bigint) {
    const credits = this.require("credits");
    const w = this.wallet("faucet");
    const mintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;
    await this.send("faucet", this.cfg.chain.usdg, mintAbi as unknown as Abi, "mint", [w.account.address, units]);
    await this.send("faucet", this.cfg.chain.usdg, erc20Abi as unknown as Abi, "approve", [credits, units]);
    return this.send("faucet", credits, CreditsAbi as unknown as Abi, "deposit", [chainKeyHash, units]);
  }

  /** Timestamp (seconds) of the latest block: the chain's own clock. */
  async latestBlockTime() {
    return Number((await this.client.getBlock({ blockTag: "latest" })).timestamp);
  }

  /** The Credits contract's current spent root (what finalizeWithdrawal checks proofs against). */
  async latestSpentRoot() {
    const credits = this.require("credits");
    const epoch = (await this.client.readContract({ address: credits, abi: CreditsAbi, functionName: "latestEpoch" })) as bigint;
    const [root, asOf, totalSpent] = (await this.client.readContract({ address: credits, abi: CreditsAbi, functionName: "spentRoot", args: [epoch] })) as [Hex, bigint, bigint];
    return { epoch, root, asOf: Number(asOf), totalSpent };
  }

  async custodyControlsReady() {
    const versions = await Promise.all([
      this.client.readContract({ address: this.require("credits"), abi: CreditsAbi, functionName: "CONTROL_VERSION" }),
      this.client.readContract({ address: this.require("providerBond"), abi: ProviderBondAbi, functionName: "CONTROL_VERSION" }),
    ]);
    return versions.every((v) => v === 2n);
  }

  async isSpentRootApproved(root: Hex, asOf: number, totalSpent: bigint) {
    // A legacy deployment without this view fails closed; no fallback to unreviewed settlement.
    return await this.client.readContract({ address: this.require("credits"), abi: CreditsAbi,
      functionName: "isRootApproved", args: [root, BigInt(asOf), totalSpent] }) as boolean;
  }

  spentRootApproval(epoch: number, root: Hex, asOf: number, totalSpent: bigint) {
    return { to: this.require("credits"), value: "0", data: encodeFunctionData({ abi: CreditsAbi,
      functionName: "approveSpentRoot", args: [BigInt(epoch), root, BigInt(asOf), totalSpent] }) };
  }

  async postSpentRoot(root: Hex, asOf: number, totalSpent: bigint) {
    return this.send("settlement", this.require("credits"), CreditsAbi as unknown as Abi, "postSpentRoot", [root, BigInt(asOf), totalSpent]);
  }
  async sweep(to: Hex, amount: bigint) {
    return this.send("settlement", this.require("credits"), CreditsAbi as unknown as Abi, "sweep", [to, amount]);
  }
  async usdgBalance(of: Hex) {
    return (await this.client.readContract({ address: this.cfg.chain.usdg, abi: erc20Abi, functionName: "balanceOf", args: [of] })) as bigint;
  }
  async ensureAllowance(role: Role, spender: Hex, amount: bigint) {
    const w = this.wallet(role);
    const current = (await this.client.readContract({ address: this.cfg.chain.usdg, abi: erc20Abi, functionName: "allowance", args: [w.account.address, spender] })) as bigint;
    if (current >= amount) return null;
    return this.send(role, this.cfg.chain.usdg, erc20Abi as unknown as Abi, "approve", [spender, amount * 10n]);
  }
  async transferUsdg(role: Role, to: Hex, amount: bigint) {
    return this.send(role, this.cfg.chain.usdg, erc20Abi as unknown as Abi, "transfer", [to, amount]);
  }
  async streamRoyalty(modelIdHash: Hex, usdg: bigint) {
    const r = this.require("royalty");
    await this.ensureAllowance("settlement", r, usdg);
    return this.send("settlement", r, RoyaltyAbi as unknown as Abi, "stream", [modelIdHash, usdg]);
  }
  async registerRoyalty(modelIdHash: Hex, creator: Hex, bps: number) {
    return this.send("router", this.require("royalty"), RoyaltyAbi as unknown as Abi, "register", [modelIdHash, creator, bps]);
  }

  // ---- Provider bonds -------------------------------------------------------------------

  async bondOf(providerIdHash: Hex) {
    const b = this.address("providerBond");
    if (!b) return null;
    return (await this.client.readContract({ address: b, abi: ProviderBondAbi, functionName: "bondOf", args: [providerIdHash] })) as bigint;
  }

  /** Slash proposals are executed by the slasher multisig. With a dev slasher key the router
   *  submits directly; otherwise it returns the Safe transaction to propose. */
  async proposeSlash(providerIdHash: Hex, kind: number, amount: bigint, evidenceRoot: Hex, delist: boolean) {
    const b = this.require("providerBond");
    const args = [providerIdHash, kind, amount, evidenceRoot, delist];
    if (this.wallets.has("slasher")) {
      const { hash, receipt } = await this.send("slasher", b, ProviderBondAbi as unknown as Abi, "proposeSlash", args);
      let slashId: bigint | null = null;
      for (const l of receipt.logs) {
        const d = l.address.toLowerCase() === b.toLowerCase() ? this.decode("providerBond", l as never) : null;
        if (d?.event === "SlashProposed") slashId = d.args.slashId as bigint;
      }
      return { submitted: true as const, hash, slashId };
    }
    return { submitted: false as const, safeTx: { to: b, value: "0", data: encodeFunctionData({ abi: ProviderBondAbi, functionName: "proposeSlash", args: args as never }) } };
  }

  async executeSlash(slashId: bigint) {
    const b = this.require("providerBond");
    const [approved, generation] = await Promise.all([
      this.client.readContract({ address: b, abi: ProviderBondAbi, functionName: "slashApproval", args: [slashId] }),
      this.client.readContract({ address: b, abi: ProviderBondAbi, functionName: "approvalGeneration" }),
    ]);
    if (approved !== generation) return { submitted: false as const, reason: "awaiting independent slash approval" };
    if (!this.wallets.has("slasher"))
      return { submitted: false as const, safeTx: { to: b, value: "0", data: encodeFunctionData({ abi: ProviderBondAbi, functionName: "executeSlash", args: [slashId] }) } };
    const { hash } = await this.send("slasher", b, ProviderBondAbi as unknown as Abi, "executeSlash", [slashId]);
    return { submitted: true as const, hash };
  }
}
