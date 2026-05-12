// Per-Telegram-chat profile store. Lives at data/users.json so a single
// agent instance can serve many chats without sharing PII via env. Email +
// phone live here, not in process.env, and never reach the model context
// (the bot injects them into the cryptorefills_buy tool via userConfig).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, "..", "data", "users.json");

export type UserProfile = {
  chatId: number;
  phone?: string;
  email?: string;
  country: string;
  createdAt: string;
  updatedAt: string;
};

type Db = Record<string, UserProfile>;

const ensureDir = () => {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const load = (): Db => {
  ensureDir();
  if (!existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8")) as Db;
  } catch {
    return {};
  }
};

const save = (db: Db) => {
  ensureDir();
  writeFileSync(STORE_PATH, JSON.stringify(db, null, 2), "utf8");
};

export const getUser = (chatId: number): UserProfile | undefined =>
  load()[String(chatId)];

export const upsertUser = (
  chatId: number,
  updates: Partial<UserProfile>,
): UserProfile => {
  const db = load();
  const key = String(chatId);
  const now = new Date().toISOString();
  const existing = db[key];
  const merged: UserProfile = {
    ...{ chatId, country: "in", createdAt: now },
    ...existing,
    ...updates,
    updatedAt: now,
  };
  db[key] = merged;
  save(db);
  return merged;
};

export const profileComplete = (p?: UserProfile): p is UserProfile =>
  Boolean(p?.phone && p?.email);

// Normalize user-typed Indian mobile numbers to E.164 with leading +.
// Accepts "6393221408", "+91 6393221408", "+91-6393221408", "916393221408".
export const normalizeIndianPhone = (raw: string): string | undefined => {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91") && /^91[6-9]/.test(digits))
    return `+${digits}`;
  return undefined;
};

export const validEmail = (raw: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
