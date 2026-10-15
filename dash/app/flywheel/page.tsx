import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { featureOn } from "../../components/dashboard/feature-switches";
import Flywheel from "./view";
export const metadata: Metadata = {
  title: "Usage flywheel — Conclave",
  description: "Chat fees, owner-approved CLVE buybacks, and verified Solana burn records.",
};
export default function Page() {
  if (!featureOn("flywheel")) notFound();
  return <Flywheel />;
}
