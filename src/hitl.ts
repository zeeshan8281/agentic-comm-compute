import { env } from "./config.js";

// HITL = human-in-the-loop. For any payment above HITL_THRESHOLD_USDC the
// agent stops and waits for a single-keystroke approval from the user. The
// approval is delivered via POST /api/confirm. We surface a Promise that
// the tool loop awaits; the HTTP handler resolves it.

type Pending = {
  resolve: (approved: boolean) => void;
  prompt: { amountUsdc: string; merchantId: string; itemId: string };
};

const pending = new Map<string, Pending>();

export const requestApproval = (
  sessionId: string,
  prompt: Pending["prompt"],
): Promise<boolean> => {
  if (env.HITL_AUTO_APPROVE) return Promise.resolve(true);
  return new Promise((resolve) => {
    pending.set(sessionId, { resolve, prompt });
  });
};

export const resolveApproval = (sessionId: string, approved: boolean): boolean => {
  const p = pending.get(sessionId);
  if (!p) return false;
  pending.delete(sessionId);
  p.resolve(approved);
  return true;
};

export const getPendingPrompt = (sessionId: string) => pending.get(sessionId)?.prompt;
