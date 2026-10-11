import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "The field guide — Conclave",
  description:
    "Understand Conclave Route Cards, guards, model comparison, proposed billing and the boundaries of the local workspace preview.",
};

export default function DocumentationLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
