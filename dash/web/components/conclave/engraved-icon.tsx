import Image from "next/image";
import "./engraved-icon.css";

export type EngravedIconName =
  "gauntlet" | "key" | "shield" | "coins" | "scroll";

/** Decorative editorial icons. The adjacent visible copy names the action. */
export function EngravedIcon({
  name,
  size = 64,
  className = "",
}: {
  name: EngravedIconName;
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src={`/brand/icons/conclave-${name}-halftone-v1.png`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      unoptimized
      className={`engraved-icon ${className}`}
    />
  );
}
