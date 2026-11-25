import { rv } from "./common.ts";
import type { TableDoc } from "../types.ts";

export const memorySyncTables: Record<string, TableDoc> = {
  memory_blobs: {
    category: "keys",
    purpose: "Device-encrypted Vault Memory items and sync tombstones.",
    request: "no",
    retention: "Retained for sync until the caller deletes the item or vault.",
    columns: {
      vault_id: {
        purpose: "Vault identifier derived on device from its memory secret.",
        review: rv(["type:binary"], "no-request-content", "A fixed-length credential identifier with no association to any Anonymo API key."),
      },
      item_id: "Random ID of this item within the vault.",
      version: "Positive revision number for resolving sync conflicts.",
      ciphertext: {
        purpose: "Client-encrypted memory item or an empty tombstone.",
        review: rv(["type:binary"], "no-request-content", "Only authenticated ciphertext is stored. The device derives the encryption key from a secret it keeps."),
      },
      deleted: "Whether the record is a deletion tombstone.",
      updated_at: "Timestamp of the last accepted change.",
    },
  },
};
