import type { ComponentPropsWithoutRef } from "react";

/** Native navigation avoids Vinext beta's production RSC namespace mismatch.
 * Hash links retain normal browser history; dashboard view links handle their
 * own local state. Keep this until the framework's compiled router is verified.
 */
export default function SiteLink({ children, ...props }: ComponentPropsWithoutRef<"a">) {
  return <a {...props}>{children}</a>;
}
