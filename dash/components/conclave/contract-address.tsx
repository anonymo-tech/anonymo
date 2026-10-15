"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import "./contract-address.css";

const CONTRACT_ADDRESS = "8pe4i3qKgta9pFgDrnQJtakv6ArqUUGswtax12aEpump";

export function ContractAddress({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (reset.current) clearTimeout(reset.current); }, []);

  const copyAddress = async () => {
    if (reset.current) clearTimeout(reset.current);
    let copied = false;
    try {
      await navigator.clipboard.writeText(CONTRACT_ADDRESS);
      copied = true;
    } catch {
      const input = document.createElement("textarea");
      const focused = document.activeElement;
      input.value = CONTRACT_ADDRESS;
      input.readOnly = true;
      input.style.cssText = "position:fixed;top:0;left:-9999px;font-size:16px";
      document.body.appendChild(input);
      try {
        input.select();
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        input.remove();
        if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
      }
    }
    setStatus(copied ? "copied" : "error");
    reset.current = setTimeout(() => setStatus("idle"), 2600);
  };

  return (
    <div className={`cl-contract ${compact ? "cl-contract--compact" : ""}`}>
      <button
        type="button"
        className="cl-contract__button"
        onClick={() => void copyAddress()}
        aria-label="Copy Conclave contract address"
        title={CONTRACT_ADDRESS}
        data-copied={status === "copied"}
      >
        <span className="cl-contract__label">CA</span>
        <span className="cl-contract__address">
          {compact ? `${CONTRACT_ADDRESS.slice(0, 8)}…${CONTRACT_ADDRESS.slice(-6)}` : CONTRACT_ADDRESS}
        </span>
        <span className="cl-contract__action">
          {status === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          <span>{status === "copied" ? "Copied" : status === "error" ? "Retry" : "Copy"}</span>
        </span>
      </button>
      <span className="cl-contract__announcement" role="status">
        {status === "copied" ? "Contract address copied." : status === "error" ? "Copy unavailable. Select the full contract address in the footer to copy it manually." : ""}
      </span>
    </div>
  );
}
