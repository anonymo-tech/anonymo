// End-to-end check of the money path on a Robinhood Chain fork (anvil) or on Robinhood Chain testnet, with the real
// gateway in between. TEST ONLY: every key here is a throwaway test key.
//
//   1. Deploys a real Safe 1.4.1 (2 of 3), the router and token stages, and an ANMO/quote Uniswap v3 pool
//      (contracts/script/anonymo/E2ESetup.s.sol).
//   2. Moves coins out of the Safe with a 2-of-3 signed Safe transaction, seeds the pool, funds a test user.
//   3. Starts the gateway (scripts/launch.ts: mock models, local database) watching the router and CoinPay.
//   4. As a visitor: creates a key, deposits the quote stablecoin through the router, pays coins through CoinPay,
//      chats, opens the receipt, and withdraws, checking the balance after each step.
//
//   bun scripts/anonymo-e2e.ts --rpc http://127.0.0.1:8546 --keys <file> [--fork] [--twap 60]
// <file> is JSON: { deployer, owners: [3], user } private keys (0x…). With --fork the script uses anvil cheats to
// fund accounts with ETH and the quote token (impersonating a holder) and to skip the TWAP window; on a testnet the
// deployer must hold gas and quote tokens (E2E_QUOTE_HOLDER is then the deployer) and the run waits out the window.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import cfg from "../config/rhc-mainnet.json";

const ROOT = resolve(import.meta.dir, "..");
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const RPC = arg("--rpc", "http://127.0.0.1:8546")!;
const FORK = process.argv.includes("--fork");
const TWAP = Number(arg("--twap", FORK ? "1800" : "60"));
const API_PORT = Number(arg("--port", "8899"));
const API = `http://127.0.0.1:${API_PORT}`;
const keys = JSON.parse(readFileSync(arg("--keys")!, "utf8")) as { deployer: Hex; owners: Hex[]; user: Hex };
const QUOTE = (arg("--quote") ?? cfg.usdg.address) as Hex;
const QUOTE_HOLDER = arg("--quote-holder") as Hex | undefined; // fork: an address holding the quote token
const V3_FACTORY = (arg("--v3-factory") ?? cfg.uniswap.v3Factory) as Hex;

const say = (m: string) => console.log(`[e2e] ${m}`);
const ok = (cond: unknown, m: string) => {
  if (!cond) throw new Error(`FAILED: ${m}`);
  say(`ok  ${m}`);
};

const pub = createPublicClient({ transport: http(RPC) });
const chainId = await pub.getChainId();
const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const wallet = (pk: Hex) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(RPC) });
const deployer = privateKeyToAccount(keys.deployer);
const user = privateKeyToAccount(keys.user);
const owners = keys.owners.map((k) => privateKeyToAccount(k));
const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
const send = async (pk: Hex, to: Hex, data: Hex) => {
  const hash = await wallet(pk).sendTransaction({ to, data, chain });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return r;
};
const ERC20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const SAFE = parseAbi([
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes signatures) payable returns (bool)",
]);
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

/** A Safe transaction signed by two of the three owners (sorted by address, as the Safe requires). */
async function safeExec(safe: Hex, to: Hex, data: Hex) {
  const nonce = await pub.readContract({ address: safe, abi: SAFE, functionName: "nonce" });
  const hash = await pub.readContract({ address: safe, abi: SAFE, functionName: "getTransactionHash", args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce] });
  const signers = [0, 1].map((i) => ({ addr: owners[i].address.toLowerCase(), pk: keys.owners[i] })).sort((a, b) => (a.addr < b.addr ? -1 : 1));
  let sigs = "0x";
  for (const s of signers) {
    const { r, s: ss, v } = await sign({ hash, privateKey: s.pk });
    sigs += r.slice(2) + ss.slice(2) + Number(v).toString(16).padStart(2, "0");
  }
  await send(keys.deployer, safe, encodeFunctionData({ abi: SAFE, functionName: "execTransaction", args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, sigs as Hex] }));
}

/** sqrtPriceX96 for `usdPerCoin` (coin 18 decimals, quote 6), for either token order. */
function sqrtPrices(usdPerCoin: number) {
  const raw0 = usdPerCoin * 1e6 / 1e18; // quote raw per coin raw, coin = token0
  const toX96 = (p: number) => BigInt(Math.floor(Math.sqrt(p) * 2 ** 48)) * 2n ** 48n;
  return { coin0: toX96(raw0), coin1: toX96(1 / raw0) };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1_500);
  }
}

/** A fork mines only on transactions; a real chain keeps going. Mine a few blocks so payments get confirmations. */
const settle = async () => {
  if (FORK) await rpc("anvil_mine", ["0x3"]);
};

// ---------------------------------------------------------------------------------------------------------------- 1
say(`chain ${chainId} at ${RPC}${FORK ? " (fork)" : ""}`);
if (FORK) for (const a of [deployer.address, user.address, ...owners.map((o) => o.address)]) await rpc("anvil_setBalance", [a, "0x56BC75E2D63100000"]);
else if ((await pub.getBalance({ address: user.address })) < parseEther("0.001")) {
  const hash = await wallet(keys.deployer).sendTransaction({ to: user.address, value: parseEther("0.001"), chain });
  await pub.waitForTransactionReceipt({ hash });
  say("sent the test user 0.001 ETH for gas");
}
// The watcher's start block, read from the RPC: inside a contract, block.number on Arbitrum-family chains is the L1 block.
const startBlock = Number(await pub.getBlockNumber());
const sp = sqrtPrices(0.1); // $0.10 per coin
const setup = Bun.spawnSync(
  ["forge", "script", "script/anonymo/E2ESetup.s.sol", "--tc", "E2ESetup", "--rpc-url", RPC, "--broadcast", "--private-key", keys.deployer, "--slow"],
  {
    cwd: resolve(ROOT, "contracts"),
    env: {
      ...process.env,
      E2E_DEPLOYER: deployer.address,
      E2E_OWNERS: owners.map((o) => o.address).join(","),
      E2E_QUOTE: QUOTE,
      E2E_V3_FACTORY: V3_FACTORY,
      E2E_SAFE_SINGLETON: cfg.safe141.singleton,
      E2E_SAFE_FACTORY: cfg.safe141.proxyFactory,
      E2E_SQRT_COIN0: sp.coin0.toString(),
      E2E_SQRT_COIN1: sp.coin1.toString(),
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (setup.exitCode !== 0) {
  console.error(setup.stdout.toString().slice(-3000), setup.stderr.toString().slice(-3000));
  throw new Error("E2ESetup failed");
}
const d = JSON.parse(readFileSync(resolve(ROOT, `contracts/deployments/${chainId}-anonymo-e2e.json`), "utf8")) as Record<string, Hex | number>;
const [ROUTER, ANMO, COINPAY, POOL, SEEDER, SAFE_ADDR] = [d.depositRouter, d.anmo, d.coinPay, d.pool, d.seeder, d.safe] as Hex[];
say(`deployed: safe ${SAFE_ADDR} router ${ROUTER} coin ${ANMO} coinPay ${COINPAY} pool ${POOL}`);

// ---------------------------------------------------------------------------------------------------------------- 2
await safeExec(SAFE_ADDR, ANMO, encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [SEEDER, parseEther("1000000")] }));
await safeExec(SAFE_ADDR, ANMO, encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [user.address, parseEther("10000")] }));
ok((await pub.readContract({ address: ANMO, abi: ERC20, functionName: "balanceOf", args: [user.address] })) === parseEther("10000"), "a 2-of-3 Safe transaction moved coins out of the treasury");

const quoteFrom = QUOTE_HOLDER ?? deployer.address;
if (FORK && QUOTE_HOLDER) {
  await rpc("anvil_impersonateAccount", [QUOTE_HOLDER]);
  await rpc("anvil_setBalance", [QUOTE_HOLDER, "0x56BC75E2D63100000"]);
}
const fundQuote = async (to: Hex, amount: bigint) => {
  if (FORK && QUOTE_HOLDER) {
    const hash = await createWalletClient({ account: QUOTE_HOLDER, chain, transport: http(RPC) }).sendTransaction({ to: QUOTE, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] }), chain });
    await pub.waitForTransactionReceipt({ hash });
  } else await send(keys.deployer, QUOTE, encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] }));
};
await fundQuote(SEEDER, 100_000n * 10n ** 6n);
await fundQuote(user.address, 50n * 10n ** 6n);
if (FORK) await fundQuote(deployer.address, 100n * 10n ** 6n); // the deployer doubles as the withdrawal hot wallet
say(`funded the pool seeder and the test user with the quote token from ${quoteFrom}`);
const SEEDER_ABI = parseAbi(["function seed(address pool, uint128 liquidity)"]);
await send(keys.deployer, SEEDER, encodeFunctionData({ abi: SEEDER_ABI, functionName: "seed", args: [POOL, 10n ** 15n] }));
say("seeded the pool with full-range liquidity at $0.10 per coin");
if (FORK) {
  await rpc("evm_increaseTime", [TWAP + 60]);
  await rpc("evm_mine", []);
  say(`advanced the fork past the ${TWAP}s average window`);
}

// ---------------------------------------------------------------------------------------------------------------- 3
const env = {
  ANONYMO_EVM_CHAINS: JSON.stringify([{ chain: "rhc", rpcUrl: RPC, router: ROUTER, confirmations: 1, startBlock, maxRange: 500, tokens: [{ symbol: "USDG", address: QUOTE, decimals: 6 }] }]),
  ANONYMO_COIN: JSON.stringify({ rpcUrl: RPC, chainId, coinPay: COINPAY, token: { address: ANMO }, pool: POOL, quote: { address: QUOTE }, twapSeconds: TWAP, confirmations: 1, startBlock, maxRange: 500, maxUsdPerPayment: "250" }),
  ANONYMO_WATCH_EVERY_MS: "2000",
  WORKERS: "true",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  // The withdrawal hot wallet (test only: the deployer, which holds quote tokens).
  ANONYMO_PAYOUT_PRIVATE_KEY: keys.deployer,
};
say(`starting the gateway on ${API}`);
const gw = Bun.spawn(["bun", "scripts/launch.ts", "--fresh", "--port", String(API_PORT)], { cwd: ROOT, env: { ...process.env, ...env }, stdout: Bun.file(resolve(ROOT, ".data/e2e-gateway.log")), stderr: Bun.file(resolve(ROOT, ".data/e2e-gateway.log")) });
const stop = () => gw.kill("SIGINT");
process.on("exit", stop);
try {
  await waitFor("the gateway", async () => (await fetch(`${API}/health`)).ok, 180_000);

  // ---------------------------------------------------------------------------------------------------------------- 4
  const minted = (await (await fetch(`${API}/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { key: string; deposit: { evm: { key_commit: Hex }; coin: { price_usd: string | null } } };
  const auth = { authorization: `Bearer ${minted.key}` };
  const commit = minted.deposit.evm.key_commit;
  ok(/^0x[0-9a-f]{64}$/.test(commit), "a visitor created a key with no identity and got a deposit commitment");
  const balance = async () => (await (await fetch(`${API}/balance`, { headers: auth })).json()) as { available_usd: number; usage_only_usd: number; withdraw_to: { chain: string; address: string; max_usd: number }[] };
  const price = await waitFor("a coin price", async () => {
    const i = (await (await fetch(`${API}/deposits`, { headers: auth })).json()) as { instructions: { coin: { price_usd: string | null } } };
    return i.instructions.coin.price_usd;
  });
  ok(Math.abs(Number(price) - 0.1) < 0.002, `the gateway reads the coin price from the pool: $${price}`);

  const ROUTER_ABI = parseAbi(["function deposit(address token,uint256 amount,bytes32 keyCommit)"]);
  await send(keys.user, QUOTE, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [ROUTER, 5_000_000n] }));
  await send(keys.user, ROUTER, encodeFunctionData({ abi: ROUTER_ABI, functionName: "deposit", args: [QUOTE, 5_000_000n, commit] }));
  ok((await pub.readContract({ address: QUOTE, abi: ERC20, functionName: "balanceOf", args: [ROUTER] })) === 0n, "the router forwarded the deposit and holds nothing");
  await settle();
  const afterDeposit = await waitFor("the USDG deposit credit", async () => {
    const b = await balance();
    return b.available_usd >= 4.99 ? b : null;
  });
  ok(afterDeposit.available_usd === 5, `the $5 deposit was credited: $${afterDeposit.available_usd}`);

  const COINPAY_ABI = parseAbi(["function pay(uint256 amount, bytes32 keyCommit)"]);
  const supplyBefore = await pub.readContract({ address: ANMO, abi: ERC20, functionName: "totalSupply" });
  await send(keys.user, ANMO, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [COINPAY, parseEther("100")] }));
  await send(keys.user, COINPAY, encodeFunctionData({ abi: COINPAY_ABI, functionName: "pay", args: [parseEther("100"), commit] }));
  ok(supplyBefore - (await pub.readContract({ address: ANMO, abi: ERC20, functionName: "totalSupply" })) === parseEther("100"), "paying 100 coins burned 100 coins");
  await settle();
  const afterCoin = await waitFor("the coin payment credit", async () => {
    const b = await balance();
    return b.available_usd > 14 ? b : null;
  });
  ok(Math.abs(afterCoin.available_usd - 15) < 0.1 && Math.abs(afterCoin.usage_only_usd - 10) < 0.1, `100 coins at $0.10 credited ~$10, usage only: available $${afterCoin.available_usd}, usage-only $${afterCoin.usage_only_usd}`);

  const chat = await fetch(`${API}/v1/chat/completions`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ model: "anonymo-1", messages: [{ role: "user", content: "say hello" }] }) });
  const chatBody = await chat.text();
  ok(chat.status === 200, `chat with anonymo-1 answered 200${chat.status !== 200 ? `: ${chatBody.slice(0, 200)}` : ""}`);
  ok(chat.headers.get("x-anonymo-receipt"), "the answer carries a signed receipt header");
  const parsed = JSON.parse(chatBody) as { id?: string; anonymo_receipt?: { id?: string; request_id?: string; payload?: { request_id?: string } } };
  const receiptId = parsed.anonymo_receipt?.id ?? parsed.anonymo_receipt?.request_id ?? parsed.anonymo_receipt?.payload?.request_id ?? parsed.id;
  ok(receiptId, `the answer names its receipt (${receiptId})`);
  const receipt = await fetch(`${API}/v1/receipts/${receiptId}`, { headers: auth });
  ok(receipt.ok, "the receipt can be fetched");

  const afterChat = await balance();
  ok(afterChat.available_usd < afterCoin.available_usd, `the chat was charged: $${(afterCoin.available_usd - afterChat.available_usd).toFixed(6)}`);
  const dest = afterChat.withdraw_to.find((w) => w.chain === "rhc" && w.address === user.address.toLowerCase());
  ok(dest && dest.max_usd <= 5, `only stablecoin credit is withdrawable to the depositor: max $${dest?.max_usd}`);
  const userQuoteBefore = await pub.readContract({ address: QUOTE, abi: ERC20, functionName: "balanceOf", args: [user.address] });
  const wd = await fetch(`${API}/withdraw`, { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": `e2e-${Date.now()}` }, body: JSON.stringify({ chain: "rhc", to: user.address, amount_usd: "all" }) });
  const wdBody = (await wd.json()) as { withdrawal?: { id: string; amount_usd: number; status: string } };
  ok(wd.status === 202 && wdBody.withdrawal && wdBody.withdrawal.amount_usd <= 5, `withdrawal accepted for $${wdBody.withdrawal?.amount_usd}`);
  const sent = await waitFor("the payout", async () => {
    const list = (await (await fetch(`${API}/withdrawals`, { headers: auth })).json()) as { data: { id: string; status: string; tx: string | null }[] };
    const w = list.data.find((x) => x.id === wdBody.withdrawal!.id);
    return w?.status === "sent" ? w : null;
  });
  const received = (await pub.readContract({ address: QUOTE, abi: ERC20, functionName: "balanceOf", args: [user.address] })) - userQuoteBefore;
  ok(received > 0n && received === BigInt(Math.floor(wdBody.withdrawal!.amount_usd * 1e6)), `the hot wallet paid the withdrawal on-chain: ${Number(received) / 1e6} in tx ${sent.tx}`);
  const tooMuch = await fetch(`${API}/withdraw`, { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": `e2e-more-${Date.now()}` }, body: JSON.stringify({ chain: "rhc", to: user.address, amount_usd: "1" }) });
  ok(tooMuch.status === 402 || tooMuch.status === 403, `coin credit cannot be withdrawn (${tooMuch.status})`);
  say("ALL CHECKS PASSED");
  writeFileSync(resolve(ROOT, `.data/e2e-${chainId}.json`), JSON.stringify({ ...d, passedAt: new Date().toISOString() }, null, 2));
} finally {
  stop();
  await Promise.race([gw.exited, Bun.sleep(10_000)]);
}
if (!existsSync(resolve(ROOT, `.data/e2e-${chainId}.json`))) process.exit(1);
