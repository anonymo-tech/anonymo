import { notFound } from 'next/navigation';
import { PublicPage } from '@/components/site-chrome';
import { RedeemCode } from '@/components/redeem-code';
import { DEMO_BY_DEFAULT } from '@/lib/anonymo/config';
import { updateOn } from '@/lib/anonymo/updates';
import './redeem.css';

export const metadata = {
  title: 'Redeem an Anonymo Code',
  robots: { index: false, follow: false },
};

export default function RedeemPage() {
  if (!updateOn('codes', DEMO_BY_DEFAULT)) notFound();
  return <PublicPage><RedeemCode /></PublicPage>;
}
