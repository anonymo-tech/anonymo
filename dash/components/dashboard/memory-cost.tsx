import Link from 'next/link';
import { formatUsdAmount } from '@/lib/anonymo/money';
import type { MemoryCharge } from '@/lib/anonymo/memory-request';

export function MemoryCost({ charge }: { charge: MemoryCharge }) {
  const cost = charge.cost === null ? 'Cost unavailable' : formatUsdAmount(charge.cost);
  return (
    <span className="memory-charge">
      Memory check · {charge.receiptId
        ? <Link className="mono" href={`/dashboard/receipts/${encodeURIComponent(charge.receiptId)}`} aria-label={`Memory check receipt, ${cost}`}>{cost}</Link>
        : <span className="mono">{cost}</span>}
    </span>
  );
}
