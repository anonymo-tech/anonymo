import type { Metadata } from 'next';
import { Roadmap } from '@/components/conclave/publication';
export const metadata: Metadata = {
  title: 'Roadmap — Conclave',
  description:
    'Seven release chapters across the Conclave workspace, Second Look, Guarded Wallet, Rooms, mobile and agent access.',
  alternates: { canonical: 'https://conclavemodels.com/roadmap' },
};
export default Roadmap;
