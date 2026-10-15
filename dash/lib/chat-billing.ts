type Billing = { state: string; actualUsd6: string | null; maximumUsd6: string | null };
const micros = (value: string | null) => value !== null && /^\d{1,20}$/.test(value) ? BigInt(value) : null;

/** A reservation is never presented as a charge, including during reconciliation. */
export function chatBillingSummary(bills: readonly Billing[]) {
  let charged = 0n, reserved = 0n, pending = 0, unknown = false;
  for (const bill of bills) {
    const actual = micros(bill.actualUsd6), maximum = micros(bill.maximumUsd6);
    if (bill.state === 'captured' && actual !== null) charged += actual;
    else if (bill.state === 'released' && (actual === null || actual === 0n)) continue;
    else {
      pending++;
      if (maximum === null) unknown = true;
      else reserved += maximum;
    }
  }
  return { chargedUsd6: charged.toString(), reservedUsd6: reserved.toString(), pending, unknown };
}
