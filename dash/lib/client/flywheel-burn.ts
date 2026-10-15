import bs58 from "bs58";
// Reconstruct the sole permitted BurnChecked message independently of the API.
// The wallet never receives a server-supplied transfer or approval instruction.
export function validateFlywheelBurn(base64: string, amount: bigint): Uint8Array {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (bytes.length !== 246 || amount <= 0n || amount >= 2n ** 64n)
    throw new Error("Invalid burn transaction.");
  const addresses = [
    "49exMtr1QiaN6mcHszMe2nAMwbEVCngZmV134Ua5c5Q1",
    "AiVY4zfBsxKtVxx3xGcW1iPfoWcTN4dEbnrNm1a3fVhp",
    "8pe4i3qKgta9pFgDrnQJtakv6ArqUUGswtax12aEpump",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ];
  const raw = Array.from({ length: 8 }, (_, i) => Number((amount >> BigInt(i * 8)) & 255n));
  const expected = Uint8Array.from([
    1,
    ...new Uint8Array(64),
    1,
    0,
    1,
    4,
    ...addresses.flatMap((a) => [...bs58.decode(a)]),
    ...bytes.slice(197, 229),
    1,
    3,
    3,
    1,
    2,
    0,
    10,
    15,
    ...raw,
    6,
  ]);
  if (expected.length !== bytes.length || !expected.every((b, i) => b === bytes[i]))
    throw new Error("The transaction differs from the approved CLVE burn.");
  return bytes;
}
