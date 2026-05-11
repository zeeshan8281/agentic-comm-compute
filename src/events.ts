import { EventEmitter } from "node:events";
import type { TimelineEvent } from "./types.js";

class SessionBus extends EventEmitter {
  history: TimelineEvent[] = [];

  emitEvent(ev: Omit<TimelineEvent, "ts"> & { ts?: string }) {
    const full: TimelineEvent = { ts: ev.ts ?? new Date().toISOString(), ...ev };
    this.history.push(full);
    this.emit("event", full);
  }
}

// Sessions are keyed by id. SSE clients subscribe per-session.
const sessions = new Map<string, SessionBus>();

export const getSession = (id: string): SessionBus => {
  let s = sessions.get(id);
  if (!s) {
    s = new SessionBus();
    sessions.set(id, s);
  }
  return s;
};

export const clearSession = (id: string) => sessions.delete(id);
