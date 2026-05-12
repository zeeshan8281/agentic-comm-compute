// Conversational Telegram bot. Each chat is a single user; the bot routes
// each text message through a small intent classifier (regex fast-path for
// phone/email, LLM fallback for free-form purchase intents) then either
// updates the profile or invokes the agent runtime. PII (phone/email) lives
// in data/users.json and is passed to cryptorefills_buy via userConfig — the
// model that orchestrates the purchase never sees it.

import { Telegraf, Markup, type Context } from "telegraf";
import { generateObject, generateText, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import pino from "pino";
import { env } from "./config.js";
import {
  getUser,
  upsertUser,
  profileComplete,
  normalizeIndianPhone,
  validEmail,
  type UserProfile,
} from "./user-store.js";
import { runAgent } from "./agent.js";
import { getSession } from "./events.js";
import { resolveApproval } from "./hitl.js";
import type { TimelineEvent } from "./types.js";

const log = pino({ level: env.LOG_LEVEL }).child({ module: "telegram" });

// One Telegram chat can do many purchases in sequence; each gets its own
// sessionId so receipts/events don't bleed across purchases.
const purchaseSeq = new Map<number, number>();
const nextSessionId = (chatId: number) => {
  const n = (purchaseSeq.get(chatId) ?? 0) + 1;
  purchaseSeq.set(chatId, n);
  return `tg-${chatId}-${n}`;
};

// In-memory rolling chat history per chatId. Capped so context doesn't grow
// without bound — the bot is transactional, the user doesn't need long memory.
const chatHistory = new Map<number, ModelMessage[]>();
const HISTORY_MAX = 12;
const pushHistory = (chatId: number, msg: ModelMessage) => {
  const arr = chatHistory.get(chatId) ?? [];
  arr.push(msg);
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  chatHistory.set(chatId, arr);
};

const cbApprove = (sid: string) => `hitl:approve:${sid}`;
const cbReject = (sid: string) => `hitl:reject:${sid}`;

const WELCOME = `Hey, I'm the agentic-commerce bot.

I can buy mobile recharges, data packs, and gift cards in India — paid in USDC on Base. Just chat with me normally:

  · "6 GB data pack to my Jio number"
  · "₹100 Airtel topup"
  · "Swiggy ₹250 gift card"

First, send me:
  · your phone number (Indian mobile, the one being topped up)
  · your email (where vouchers are delivered)

I never share this. PII stays sealed in the agent's env — the AI that does the buying never sees it.`;

const HELP = `Send a purchase intent in plain English:
  · "₹100 Jio recharge"
  · "5 GB Airtel data"
  · "BookMyShow ₹250"

Commands:
  /profile — show your saved phone + email
  /reset   — clear your profile
  /help    — this message`;

// Schema for the LLM intent classifier. Regex fast-path covers phone +
// email; LLM only fires on free-form text that isn't trivially one of those.
const IntentSchema = z.object({
  intent: z.enum(["purchase", "show_profile", "help", "chat"]),
  item: z
    .string()
    .optional()
    .describe("Free-form item description, e.g. 'Reliance Jio Data 6 GB' or 'Swiggy ₹250'"),
  maxUsdc: z
    .number()
    .optional()
    .describe(
      "Spending cap in USDC. If user names ₹X, set this to (X/84)*1.25 to leave headroom for the merchant quote. If unknown, leave undefined.",
    ),
});
type Intent = z.infer<typeof IntentSchema>;

const classifyIntent = async (
  text: string,
  profile: UserProfile | undefined,
): Promise<Intent & { phone?: string; email?: string }> => {
  // Fast-path: phone or email in plain text → set_profile.
  const phone = normalizeIndianPhone(text);
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (phone || emailMatch) {
    return {
      intent: "chat", // ignored; the upsert path handles routing
      phone,
      email: emailMatch ? emailMatch[0] : undefined,
    };
  }

  const sys = `You classify Telegram messages for an India-only USDC purchase bot.
Pick exactly one intent:
- "purchase": user wants to buy a recharge / data pack / gift card. Extract a brief item description and a USDC ceiling.
- "show_profile": user wants to see their saved info.
- "help": user is asking how the bot works.
- "chat": small talk or anything else.

User profile status: phone=${profile?.phone ? "set" : "missing"}, email=${profile?.email ? "set" : "missing"}.
Country: India. Common brands: Reliance Jio Data, Airtel Credits, Vi Bundle, BSNL Data, Swiggy, Zomato, BookMyShow, Google Play, Amazon Pay, Phonepe, Nykaa.`;

  try {
    const { object } = await generateObject({
      model: env.ANTHROPIC_API_KEY ? anthropic(env.AGENT_MODEL) : env.AGENT_MODEL,
      system: sys,
      prompt: text,
      schema: IntentSchema,
    });
    return object;
  } catch (err) {
    log.warn({ err }, "intent classifier failed");
    return { intent: "chat" };
  }
};

// Free-form chat reply for anything that isn't a purchase / profile / help.
// Short, on-brand, nudges toward what the bot actually does without sounding
// like a help screen every time.
const chatReply = async (
  chatId: number,
  text: string,
  profile: UserProfile | undefined,
): Promise<string> => {
  const sys = `You are @ac_eigen_bot, a friendly Telegram bot that buys mobile recharges, data packs, and gift cards in India, settled in USDC on Base mainnet via the x402 protocol. You run inside an EigenCompute TEE — the user's phone + email are sealed in env and you (the model) never see them; only a separate purchase tool does.

Style: short, casual, lowercase-friendly, 1–3 sentences, no markdown headers, no bullet lists unless the user explicitly asks. Match the user's energy. Be a real chat partner, not a help screen. If the user is making small talk, just chat back. Only nudge toward a purchase if it fits naturally.

Capabilities you can mention if asked: Jio/Airtel/Vi/BSNL recharges & data, gift cards for Swiggy / Zomato / BookMyShow / Amazon.in / Google Play / Nykaa / Phonepe, and ~140 other India brands via Cryptorefills. Examples a user can send: "6 GB Jio data pack", "₹100 Airtel topup", "Swiggy ₹250 gift card". Minimum order ~0.55 USDC (€0.50 merchant floor).

Profile status: phone=${profile?.phone ?? "not set"}, email=${profile?.email ?? "not set"}. If both are missing and the user seems ready to buy, mention you need them first. Otherwise don't push.

Don't make up prices, voucher codes, or order outcomes. Don't claim to have done something — the purchase tool is separate and the user will see live events when one actually fires.`;

  const history = chatHistory.get(chatId) ?? [];
  try {
    const { text: reply } = await generateText({
      model: env.ANTHROPIC_API_KEY ? anthropic(env.AGENT_MODEL) : env.AGENT_MODEL,
      system: sys,
      messages: [...history, { role: "user", content: text }],
    });
    pushHistory(chatId, { role: "user", content: text });
    pushHistory(chatId, { role: "assistant", content: reply });
    return reply.trim() || "hmm, didn't catch that — try \"₹100 Jio recharge\".";
  } catch (err) {
    log.warn({ err }, "chat reply failed");
    return "had a hiccup on my end. try \"₹100 Jio recharge\" or /help.";
  }
};

// Map agent event kinds → short user-friendly lines. Returns null to skip.
const formatEvent = (ev: TimelineEvent): string | null => {
  switch (ev.kind) {
    case "request_received":
      return `📦 ${ev.message}`;
    case "discover_offers":
      return `🔎 ${ev.message}`;
    case "fetch_quote":
    case "quote_received":
      return `💸 ${ev.message}`;
    case "pay_x402":
      return `🔐 ${ev.message}`;
    case "payment_settled":
      return `✅ ${ev.message}`;
    case "asset_received":
      return `🎉 ${ev.message}`;
    case "error":
      return `⚠️ ${ev.message}`;
    default:
      return null;
  }
};

const runPurchase = async (
  ctx: Context,
  chatId: number,
  profile: UserProfile,
  item: string,
  maxUsdc: number,
) => {
  const sessionId = nextSessionId(chatId);
  const session = getSession(sessionId);

  const onEvent = async (ev: TimelineEvent) => {
    try {
      if (ev.kind === "hitl_requested") {
        const usd = (ev.data as { amountUsdc?: string } | undefined)?.amountUsdc ?? "?";
        await ctx.reply(
          `🛑 Approve ${usd} USDC?`,
          Markup.inlineKeyboard([
            Markup.button.callback("✓ Approve", cbApprove(sessionId)),
            Markup.button.callback("✗ Cancel", cbReject(sessionId)),
          ]),
        );
        return;
      }
      const line = formatEvent(ev);
      if (line) await ctx.reply(line);
    } catch (err) {
      log.warn({ err, kind: ev.kind }, "telegram emit failed");
    }
  };
  session.on("event", onEvent);

  try {
    const receipt = await runAgent({
      sessionId,
      item,
      maxUsdc,
      userConfig: {
        cryptorefillsEmail: profile.email,
        cryptorefillsBeneficiary: profile.phone,
        cryptorefillsCountry: profile.country,
      },
    });
    if (receipt.voucher?.code) {
      await ctx.reply(
        `🎟️ Voucher code: \`${receipt.voucher.code}\``,
        { parse_mode: "Markdown" },
      );
    }
    const tx = receipt.txHash && receipt.txHash !== "0x" ? receipt.txHash : "—";
    await ctx.reply(`Done · paid ${receipt.amountUsdc} USDC · tx ${tx}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Purchase failed: ${msg}`);
  } finally {
    session.off("event", onEvent);
  }
};

export const startTelegramBot = () => {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.info("TELEGRAM_BOT_TOKEN not set — skipping bot startup");
    return;
  }
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    upsertUser(ctx.chat.id, {});
    chatHistory.delete(ctx.chat.id);
    await ctx.reply(WELCOME);
  });
  bot.command("help", (ctx) => ctx.reply(HELP));
  bot.command("profile", async (ctx) => {
    const p = getUser(ctx.chat.id);
    if (!p) return ctx.reply("No profile yet. Send /start to set up.");
    await ctx.reply(
      `phone: ${p.phone ?? "missing"}\nemail: ${p.email ?? "missing"}\ncountry: ${p.country}`,
    );
  });
  bot.command("reset", async (ctx) => {
    upsertUser(ctx.chat.id, { phone: undefined, email: undefined });
    chatHistory.delete(ctx.chat.id);
    await ctx.reply("Profile cleared. Send your phone + email to set them again.");
  });

  bot.action(/^hitl:(approve|reject):(.+)$/, async (ctx) => {
    const action = (ctx.match as RegExpMatchArray)[1];
    const sessionId = (ctx.match as RegExpMatchArray)[2];
    const ok = resolveApproval(sessionId, action === "approve");
    await ctx.answerCbQuery(
      ok ? (action === "approve" ? "Approved" : "Cancelled") : "Already resolved",
    );
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // message may have been deleted or is too old to edit — ignore
    }
  });

  bot.on("text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    let profile = getUser(chatId);
    const intent = await classifyIntent(text, profile);

    // Profile updates take precedence — phone/email regex matches in user text.
    if (intent.phone || intent.email) {
      const updates: Partial<UserProfile> = {};
      if (intent.phone) updates.phone = intent.phone;
      if (intent.email && validEmail(intent.email)) updates.email = intent.email;
      const updated = upsertUser(chatId, updates);
      profile = updated;
      const stored = [
        intent.phone ? `phone ${intent.phone}` : null,
        intent.email ? `email ${intent.email}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const missing: string[] = [];
      if (!updated.phone) missing.push("phone");
      if (!updated.email) missing.push("email");
      if (missing.length) {
        await ctx.reply(`Saved (${stored}). Still need: ${missing.join(", ")}.`);
      } else {
        await ctx.reply(
          `Saved (${stored}). You're set — try "₹100 Jio recharge" or "Swiggy ₹250".`,
        );
      }
      return;
    }

    if (intent.intent === "show_profile") {
      const p = getUser(chatId);
      return ctx.reply(
        p ? `phone: ${p.phone ?? "—"}\nemail: ${p.email ?? "—"}` : "No profile yet.",
      );
    }
    if (intent.intent === "help") return ctx.reply(HELP);
    if (intent.intent === "purchase" && intent.item) {
      if (!profileComplete(profile)) {
        return ctx.reply(
          "I need your phone + email first. Send them in any order and I'll save.",
        );
      }
      pushHistory(chatId, { role: "user", content: text });
      pushHistory(chatId, {
        role: "assistant",
        content: `[kicking off purchase: ${intent.item}, cap ${intent.maxUsdc ?? 2} USDC]`,
      });
      const maxUsdc = intent.maxUsdc ?? 2;
      return runPurchase(ctx, chatId, profile, intent.item, maxUsdc);
    }
    // Everything else — chitchat, vague questions, "what can you do",
    // "are you real", etc. — gets a real LLM reply with rolling history.
    const reply = await chatReply(chatId, text, profile);
    return ctx.reply(reply);
  });

  bot.launch().catch((err: unknown) => log.error({ err }, "telegram launch failed"));
  log.info({ username: env.TELEGRAM_BOT_USERNAME }, "telegram bot started");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
};
