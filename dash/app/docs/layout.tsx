import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "The Conclave guide",
  description:
    "The Conclave vision: different model perspectives, one connected project, and a clear path from questions to creation.",
};

export default function DocumentationLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
