"use client";
import { useEffect, useState } from "react";
import bs58 from "bs58";
import type { SolanaSignAndSendTransactionFeature } from "@solana/wallet-standard-features";
import {
  connectIdentityWallet,
  preferredSignInMethod,
  requestWalletChallenge,
  signIdentityChallenge,
  verifyWalletProof,
  type StandardWallet,
} from "../../lib/client/service";
import { validateFlywheelBurn } from "../../lib/client/flywheel-burn";
import "./style.css";
const OWNER = "49exMtr1QiaN6mcHszMe2nAMwbEVCngZmV134Ua5c5Q1";
const MINT = "8pe4i3qKgta9pFgDrnQJtakv6ArqUUGswtax12aEpump";
type Summary = {
  live: boolean;
  availableUsd6: string;
  reservedUsd6: string;
  spentUsd6: string;
  tokensBurnedRaw: string;
  burnCount: number;
  asOf: string;
  burns: {
    id: string;
    spentUsd6: string;
    tokensBurnedRaw: string;
    swapSignature: string;
    burnSignature: string;
    createdAt: string;
  }[];
};
type Batch = {
  id: string;
  state: string;
  amount_usd6: string;
  bought_raw: string | null;
  swap_signature: string | null;
};
type Plan = { unsigned_transaction: string; last_valid_block_height: string };
const dollars = (v: string) =>
  "$" +
  (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const tokens = (v: string) =>
  (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
async function api(path: string, body?: unknown) {
  const r = await fetch("/api/flywheel" + path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(data.error?.message ?? "The request failed.");
  return data;
}
export default function Flywheel() {
  const [data, setData] = useState<Summary | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [owner, setOwner] = useState(false),
    [open, setOpen] = useState(false),
    [wallets, setWallets] = useState<readonly StandardWallet[]>([]),
    [wallet, setWallet] = useState<StandardWallet | null>(null),
    [batch, setBatch] = useState<Batch | null>(null),
    [plan, setPlan] = useState<Plan | null>(null),
    [amount, setAmount] = useState(""),
    [swap, setSwap] = useState(""),
    [burn, setBurn] = useState("");
  const refresh = async () => setData(await api(""));
  const refreshOwner = async () => {
    const x = await api("/owner");
    setBatch(x.batch);
    setPlan(x.plan);
    setOwner(true);
    setBurn(x.batch ? (localStorage.getItem("flywheel-burn:" + x.batch.id) ?? "") : "");
  };
  useEffect(() => {
    let alive = true;
    api("")
      .then((x) => alive && setData(x))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let off: undefined | (() => void);
    import("@wallet-standard/app").then(({ getWallets }) => {
      if (!alive) return;
      const r = getWallets();
      const update = () =>
        setWallets(r.get().filter((w) => "solana:signAndSendTransaction" in w.features));
      update();
      off = r.on("register", update);
    });
    refreshOwner().catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [open]);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request did not complete.");
    } finally {
      setBusy(false);
    }
  }
  async function connect(w: StandardWallet) {
    const accounts = await connectIdentityWallet(w),
      a = accounts.find((x) => x.address === OWNER);
    if (!a) throw new Error("Select the flywheel wallet in your wallet app.");
    const challenge = await requestWalletChallenge(OWNER, location.origin);
    await verifyWalletProof(await signIdentityChallenge(w, a, challenge, preferredSignInMethod(w)));
    setWallet(w);
    await refreshOwner();
  }
  async function signBurn() {
    if (!wallet || !batch || !plan)
      throw new Error("Connect the owner wallet and prepare the burn first.");
    const a = wallet.accounts.find((a) => a.address === OWNER);
    if (!a || !a.chains.includes("solana:mainnet"))
      throw new Error("Select the flywheel wallet on Solana mainnet.");
    const bytes = validateFlywheelBurn(plan.unsigned_transaction, BigInt(batch.bought_raw!));
    const feature = wallet.features[
      "solana:signAndSendTransaction"
    ] as SolanaSignAndSendTransactionFeature["solana:signAndSendTransaction"];
    // Only this explicit user click invokes the wallet's approval/submission dialog.
    const [sent] = await feature.signAndSendTransaction({
      account: a,
      chain: "solana:mainnet",
      transaction: bytes,
      options: { commitment: "confirmed", skipPreflight: false },
    });
    const sig = bs58.encode(sent.signature);
    setBurn(sig);
    localStorage.setItem("flywheel-burn:" + batch.id, sig);
    try {
      await api(`/batches/${batch.id}/burn`, { signature: sig });
      await refreshOwner();
    } catch {
      throw new Error(
        "Submitted. Wait for finality, then select Verify burn. Your signature is saved in this browser. Do not sign again.",
      );
    }
  }
  return (
    <main className="fw">
      <header>
        <a href="/" className="fw-brand">
          CONCLAVE
        </a>
        <nav>
          <a href="/dashboard">Open the app</a>
          <a href="/docs">Docs</a>
        </nav>
      </header>
      <section className="fw-hero">
        <p className="fw-kicker">
          <span className={data?.live ? "fw-dot" : ""} />
          {data
            ? data.live
              ? "LIVE · SOLANA MAINNET"
              : "CONFIGURATION PENDING"
            : "CHECKING STATUS"}
        </p>
        <h1>
          Usage.
          <br />
          Buyback.
          <br />
          <em>Burn.</em>
        </h1>
        <div className="fw-intro">
          <span className="fw-orbit" aria-hidden="true">
            ↻
          </span>
          <p>
            Half of the platform fee from eligible chat usage is reserved for CLVE buybacks and
            burns.
          </p>
          <small>Owner approved. Verified on chain.</small>
        </div>
      </section>
      <section className="fw-stats" aria-label="Live flywheel totals">
        <article>
          <span>MATURED RESERVE</span>
          <strong>{data ? dollars(data.availableUsd6) : "—"}</strong>
          <small>
            {data && data.reservedUsd6 !== "0"
              ? dollars(data.reservedUsd6) + " assigned to the current batch"
              : "Accounting allocation, not wallet cash"}
          </small>
        </article>
        <article>
          <span>CLVE BURNED</span>
          <strong>{data ? tokens(data.tokensBurnedRaw) : "—"}</strong>
          <small>
            {data
              ? data.burnCount + " finalized burn" + (data.burnCount === 1 ? "" : "s")
              : "Loading chain records"}
          </small>
        </article>
        <article>
          <span>VERIFIED BUYBACK SPEND</span>
          <strong>{data ? dollars(data.spentUsd6) : "—"}</strong>
          <small>Recorded after the matching burn finalizes</small>
        </article>
      </section>
      <section className="fw-how">
        <div>
          <span>01 / USE</span>
          <h2>A fee with a purpose.</h2>
          <p>
            Eligible chat requests add a 5% platform fee to the underlying model cost. Half of that
            fee is allocated to the reserve. The other half supports Conclave.
          </p>
          <p>
            Chat, comparisons and Model routes participate. Studio, Cross-Check and Brief synthesis
            are outside this release.
          </p>
        </div>
        <div>
          <span>02 / BUY BACK</span>
          <h2>The owner approves.</h2>
          <p>
            After allocations mature, the owner funds the dedicated wallet and reviews a
            USDC-to-CLVE swap on Jupiter. Each batch is bounded by the available reserve.
          </p>
          <p>
            The reserve is an accounting obligation. It does not automatically move user deposits
            into this wallet.
          </p>
        </div>
        <div>
          <span>03 / BURN</span>
          <h2>Proof, then a record.</h2>
          <p>
            The owner signs a separate burn for the exact CLVE received. Conclave verifies both
            finalized transactions before publishing the record or debiting the reserve.
          </p>
          <p>
            Burned tokens are permanently removed from circulation. This does not guarantee a token
            price or return.
          </p>
        </div>
      </section>
      <section className="fw-records">
        <div className="fw-section-title">
          <div>
            <span>THE PUBLIC RECORD</span>
            <h2>Every burn. Verifiable.</h2>
          </div>
          <button onClick={() => run(refresh)} disabled={busy}>
            Refresh
          </button>
        </div>
        {data?.burns.length ? (
          <div className="fw-table">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>USDC spent</th>
                  <th>CLVE burned</th>
                  <th>Solana evidence</th>
                </tr>
              </thead>
              <tbody>
                {data.burns.map((b) => (
                  <tr key={b.id}>
                    <td>{new Date(b.createdAt).toLocaleDateString()}</td>
                    <td>{dollars(b.spentUsd6)}</td>
                    <td>{tokens(b.tokensBurnedRaw)}</td>
                    <td>
                      <a
                        href={"https://solscan.io/tx/" + b.swapSignature}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Buyback
                      </a>{" "}
                      ·{" "}
                      <a
                        href={"https://solscan.io/tx/" + b.burnSignature}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Burn
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="fw-empty">
            <strong>{data ? "No finalized burns yet." : "Loading verified records."}</strong>
            <p>
              {data
                ? "The first owner-approved burn will appear here after chain verification."
                : ""}
            </p>
          </div>
        )}
        <small>
          {data
            ? "Reserve totals through " +
              new Date(data.asOf).toUTCString() +
              ". Allocations mature hourly; completed burns update immediately."
            : ""}
        </small>
      </section>
      <section className="fw-addresses">
        <p>
          CLVE mint{" "}
          <a href={"https://solscan.io/token/" + MINT} target="_blank" rel="noreferrer">
            {MINT}
          </a>
        </p>
        <p>
          Non-custodial owner wallet{" "}
          <a href={"https://solscan.io/account/" + OWNER} target="_blank" rel="noreferrer">
            {OWNER}
          </a>
        </p>
        <button onClick={() => setOpen(!open)} aria-expanded={open}>
          Owner controls
        </button>
      </section>
      {open && (
        <section className="fw-owner">
          <h2>Approve a batch</h2>
          <p>
            Connect the dedicated wallet. Keep its recovery phrase in your wallet app; never enter
            it here. Fund it with native USDC for the purchase and SOL for gas. Purchases and burns
            require separate wallet approvals.
          </p>
          <div className="fw-wallets">
            {wallets.map((w) => (
              <button disabled={busy} key={w.name} onClick={() => run(() => connect(w))}>
                {wallet === w ? "Connected: " : "Connect "}
                {w.name}
              </button>
            ))}
            {!wallets.length && (
              <p>
                Open this page with a Solana wallet that supports Wallet Standard transaction
                submission.
              </p>
            )}
          </div>
          {owner && (
            <>
              {!batch ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount))
                        throw new Error("Enter a USDC amount with at most six decimal places.");
                      const [a, b = ""] = amount.split(".");
                      await api("/batches", {
                        amountUsd6: (BigInt(a) * 1000000n + BigInt(b.padEnd(6, "0"))).toString(),
                      });
                      await refreshOwner();
                    });
                  }}
                >
                  <label>
                    USDC to allocate
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                    />
                  </label>
                  <button disabled={busy || !data || data.availableUsd6 === "0"}>
                    Reserve a batch
                  </button>
                  <small>
                    Limited to the matured reserve. At most one completed batch per UTC hour.
                  </small>
                </form>
              ) : (
                <div>
                  <p className="fw-batch">
                    Batch {batch.id.slice(0, 8)} · {dollars(batch.amount_usd6)} · {batch.state}
                  </p>
                  {batch.state === "reserved" ? (
                    <>
                      <p>
                        On Jupiter, use this wallet and swap exactly{" "}
                        <strong>{dollars(batch.amount_usd6)} native USDC</strong> for the CLVE mint
                        above. Review the price, slippage and wallet simulation. Return with the
                        transaction signature.
                      </p>
                      <a
                        className="fw-button"
                        href={"https://jup.ag/swap/USDC-" + MINT}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Review on Jupiter
                      </a>
                      <label>
                        Finalized buyback signature
                        <input value={swap} onChange={(e) => setSwap(e.target.value)} />
                      </label>
                      <button
                        disabled={busy || !swap}
                        onClick={() =>
                          run(async () => {
                            await api(`/batches/${batch.id}/swap`, { signature: swap.trim() });
                            await refreshOwner();
                          })
                        }
                      >
                        Verify purchase
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api(`/batches/${batch.id}/cancel`, {});
                            await refreshOwner();
                          })
                        }
                      >
                        Cancel reservation
                      </button>
                      <small>
                        Cancellation does not reverse a purchase. Only purchases verified in this
                        batch count toward its reserve.
                      </small>
                    </>
                  ) : (
                    <>
                      <p>
                        Verified purchase: <strong>{tokens(batch.bought_raw!)} CLVE</strong>. The
                        next transaction irreversibly burns exactly this amount.
                      </p>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api(`/batches/${batch.id}/burn-plan`, {});
                            await refreshOwner();
                          })
                        }
                      >
                        Prepare burn
                      </button>
                      {plan && (
                        <>
                          <button
                            disabled={busy || !wallet || !!burn}
                            onClick={() => run(signBurn)}
                          >
                            Review and sign burn in wallet
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                await api(`/batches/${batch.id}/burn-plan`, { refresh: true });
                                await refreshOwner();
                              })
                            }
                          >
                            Recover or refresh expired plan
                          </button>
                        </>
                      )}
                      <label>
                        Burn signature — paste here if the wallet closed
                        <input value={burn} onChange={(e) => setBurn(e.target.value)} />
                      </label>
                      <button
                        disabled={busy || !burn}
                        onClick={() =>
                          run(async () => {
                            await api(`/batches/${batch.id}/burn`, { signature: burn.trim() });
                            await refreshOwner();
                          })
                        }
                      >
                        Verify burn
                      </button>
                      <small>
                        If submission is uncertain, check the existing signature. Do not submit
                        another burn.
                      </small>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}
      {error && (
        <p className="fw-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <a href="/">Conclave</a>
        <span>All your models in one app.</span>
      </footer>
    </main>
  );
}
