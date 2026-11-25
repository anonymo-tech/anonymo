import type { TableDoc } from "../types.ts";

export const partyTables: Record<string, TableDoc> = {
  party_rooms: {
    category: "operations",
    request: "no",
    purpose: "Room metadata for Party and the parent record for public dice proofs.",
    retention: "Room metadata survives the live room for dice verification. No application deletion window is set.",
    columns: {
      id: "Random room identifier.",
      host_key_hash: {
        purpose: "SHA-256 of the host’s paying Anonymo key.",
        review: { covers: ["name:network", "type:binary"], verdict: "digest-only", why: "This is the key digest of the host. It has no network address or raw credential." },
      },
      ruleset: "Identifier of the open rules pack.",
      players: "Last recorded number of seats in the room.",
      mature: "Whether the host selected the mature campaign rules.",
      created_at: "Time the room metadata record was created.",
    },
  },
  dice_commits: {
    category: "operations",
    request: "no",
    purpose: "Commitments and reveals for dice rolls.",
    retention: "The proofs survive the live room. No application deletion window is set.",
    columns: {
      room_id: "Random identifier of the room that made the roll.",
      roll_no: "Sequence number of the roll within that room.",
      commit: {
        purpose: "SHA-256 commitment to the roll parameters and server seed.",
        review: { covers: ["type:binary"], verdict: "digest-only", why: "Only a cryptographic commitment to random dice inputs is stored here." },
      },
      reveal: {
        purpose: "Revealed dice seed and participant nonce, or empty for a pending roll.",
        review: { covers: ["type:binary"], verdict: "config", why: "Contains the 32-byte server seed and the 32-byte participant nonce used to calculate the result." },
      },
    },
  },
};
