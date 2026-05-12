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

// Country code → { dialCode, mobileLocalLen, leadingDigits, label }.
// Used both for phone normalization and to label profile output. India still
// validates with the strictest rule (first digit 6-9); other countries are
// permissive enough to accept the common mobile prefixes without over-fitting.
// Country is lowercased everywhere in the store.
export const SUPPORTED_COUNTRIES: Record<
  string,
  { dial: string; localLen: number; leading?: RegExp; label: string }
> = {
  in: { dial: "91", localLen: 10, leading: /^[6-9]/, label: "India 🇮🇳" },
  us: { dial: "1", localLen: 10, label: "United States 🇺🇸" },
  gb: { dial: "44", localLen: 10, label: "United Kingdom 🇬🇧" },
  // Africa — top-3 Cryptorefills catalogs. Egypt is biggest by raw count;
  // Nigeria + South Africa are mobile-recharge-heavy (Airtel/MTN/Vodacom/Glo).
  ng: { dial: "234", localLen: 10, leading: /^[7-9]/, label: "Nigeria 🇳🇬" },
  za: { dial: "27", localLen: 9, leading: /^[6-8]/, label: "South Africa 🇿🇦" },
  eg: { dial: "20", localLen: 10, leading: /^1/, label: "Egypt 🇪🇬" },
};

export const countryLabel = (cc: string): string =>
  SUPPORTED_COUNTRIES[cc.toLowerCase()]?.label ?? cc.toUpperCase();

export const isSupportedCountry = (cc: string): boolean =>
  cc.toLowerCase() in SUPPORTED_COUNTRIES;

// Per-country mobile validation. Returns the E.164 string (with leading +)
// when valid, otherwise undefined. India keeps the 6-9 leading-digit rule.
// For US/UK, leading digit isn't gated (US has no fixed range, UK mobiles
// start with 7 but landlines can also dial out, so we keep it permissive).
export const normalizePhone = (raw: string, country: string): string | undefined => {
  const meta = SUPPORTED_COUNTRIES[country.toLowerCase()];
  if (!meta) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  const local = digits.length === meta.localLen ? digits : null;
  const withDial =
    digits.length === meta.localLen + meta.dial.length && digits.startsWith(meta.dial)
      ? digits.slice(meta.dial.length)
      : null;
  const candidate = local ?? withDial;
  if (!candidate) return undefined;
  if (meta.leading && !meta.leading.test(candidate)) return undefined;
  return `+${meta.dial}${candidate}`;
};

// Phone is required for India (mobile recharges are the headline use case).
// For US / UK the headline use case is gift cards delivered to email — phone
// is optional and only requested when the user wants a mobile recharge.
export const profileComplete = (p?: UserProfile): p is UserProfile => {
  if (!p?.email) return false;
  if (p.country === "in") return Boolean(p.phone);
  return true;
};

export const validEmail = (raw: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
