import { env } from "./config.js";

// v1: caps enforced in agent code. v2 moves to the CDP Wallet policy engine
// so a misbehaving agent cannot exceed them. PRD §10 explicitly calls out
// that real enforcement does not live here.
type SessionSpend = { session: number; day: number; dayStartedAt: number };

const sessions = new Map<string, SessionSpend>();

const today = () => new Date().toISOString().slice(0, 10);
const dayMs = 24 * 60 * 60 * 1000;

const getOrInit = (sessionId: string): SessionSpend => {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { session: 0, day: 0, dayStartedAt: Date.now() };
    sessions.set(sessionId, s);
  }
  if (Date.now() - s.dayStartedAt > dayMs) {
    s.day = 0;
    s.dayStartedAt = Date.now();
  }
  return s;
};

export const requiresHitl = (amountUsdc: number): boolean =>
  amountUsdc > env.HITL_THRESHOLD_USDC;

export const assertWithinCaps = (sessionId: string, amountUsdc: number, userMaxUsdc: number) => {
  if (amountUsdc > userMaxUsdc) {
    throw new Error(`Quote ${amountUsdc} exceeds user cap ${userMaxUsdc}`);
  }
  if (amountUsdc > env.CAP_PER_PAYMENT_USDC && !requiresHitl(amountUsdc)) {
    throw new Error(`Quote ${amountUsdc} exceeds per-payment cap ${env.CAP_PER_PAYMENT_USDC}`);
  }
  const s = getOrInit(sessionId);
  if (s.session + amountUsdc > env.CAP_PER_SESSION_USDC) {
    throw new Error(
      `Per-session cap exceeded: ${s.session + amountUsdc} > ${env.CAP_PER_SESSION_USDC}`,
    );
  }
  if (s.day + amountUsdc > env.CAP_PER_DAY_USDC) {
    throw new Error(`Per-day cap exceeded: ${s.day + amountUsdc} > ${env.CAP_PER_DAY_USDC}`);
  }
};

export const recordSpend = (sessionId: string, amountUsdc: number) => {
  const s = getOrInit(sessionId);
  s.session += amountUsdc;
  s.day += amountUsdc;
};

export const getSpend = (sessionId: string) => getOrInit(sessionId);

void today;
