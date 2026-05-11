import type { Receipt } from "./types.js";

// In-memory receipt store. Swap for Postgres in v1.5 — interface is
// intentionally narrow so the swap is a one-file change.
const store = new Map<string, Receipt>();

export const saveReceipt = (r: Receipt): Receipt => {
  store.set(r.id, r);
  return r;
};

export const getReceipt = (id: string): Receipt | undefined => store.get(id);

export const listReceipts = (): Receipt[] =>
  [...store.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
