"use client";
import { useState } from "react";
import { Coins, UserRound } from "lucide-react";
import { safeFomoImageUrl } from "../../lib/second-look/fomo-view";

export function FomoEntityImage({
  src,
  label,
  kind = "token",
}: {
  src: unknown;
  label: string;
  kind?: "profile" | "token";
}) {
  const url = safeFomoImageUrl(src);
  const [failed, setFailed] = useState<string | null>(null);
  const available = Boolean(url && url !== failed);
  return (
    <span className={`fomo-entity-image is-${kind}${available ? "" : " is-fallback"}`}>
      {available ? (
        <img
          src={url!}
          alt={label}
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setFailed(url)}
        />
      ) : (
        <span role="img" aria-label={`${label}: image unavailable`} title="Image unavailable">
          {kind === "profile" ? <UserRound aria-hidden="true" /> : <Coins aria-hidden="true" />}
        </span>
      )}
    </span>
  );
}
