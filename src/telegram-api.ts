/**
 * Telegram Bot API transport. One token. No local telegram-bot-api server.
 * Long-poll (`getUpdates`) is local/dev only — production uses setWebhook.
 */

import { timingSafeEqual } from "node:crypto";

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CALLBACK_DATA_LIMIT = 64;

export type TelegramFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Pick<Response, "ok" | "status" | "statusText" | "json" | "text">>;

export interface TelegramApiOptions {
  botToken: string;
  fetch?: TelegramFetch;
  apiBase?: string;
  maxRetries?: number;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  chat_instance?: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface SendTelegramMessageOptions {
  parseMode?: "HTML";
  replyMarkup?: { inline_keyboard: TelegramInlineButton[][] };
  disableWebPagePreview?: boolean;
}

export interface TelegramApiResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(payload: TelegramApiResult, attempt: number): number {
  const fromApi = payload.parameters?.retry_after;
  if (typeof fromApi === "number" && fromApi >= 0) {
    return Math.min(fromApi * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

export class TelegramBotApi {
  readonly botToken: string;
  private customFetch: TelegramFetch;
  private apiBase: string;
  private maxRetries: number;

  constructor(options: TelegramApiOptions) {
    this.botToken = (options.botToken || "").trim();
    this.customFetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.apiBase = (options.apiBase || "https://api.telegram.org").replace(/\/$/, "");
    this.maxRetries = options.maxRetries ?? 4;
  }

  methodUrl(method: string): string {
    return `${this.apiBase}/bot${this.botToken}/${method}`;
  }

  async call<T = unknown>(
    method: string,
    body?: Record<string, unknown>
  ): Promise<TelegramApiResult<T>> {
    if (!this.botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is missing — not calling Telegram.");
    }

    let last: TelegramApiResult<T> = { ok: false, description: "not attempted" };

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.customFetch(this.methodUrl(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });

      const rawText = await res.text();
      try {
        last = JSON.parse(rawText) as TelegramApiResult<T>;
      } catch {
        last = {
          ok: false,
          error_code: res.status,
          description: rawText || res.statusText,
        };
      }

      if (last.ok) return last;

      const retryable =
        res.status === 429 ||
        last.error_code === 429 ||
        res.status >= 500;
      if (!retryable || attempt === this.maxRetries) {
        return last;
      }
      await sleep(retryAfterMs(last, attempt));
    }

    return last;
  }

  async setWebhook(input: {
    url: string;
    secretToken?: string;
    allowedUpdates?: string[];
  }): Promise<TelegramApiResult<boolean>> {
    return this.call<boolean>("setWebhook", {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: input.allowedUpdates ?? ["message", "callback_query"],
    });
  }

  async deleteWebhook(dropPending = false): Promise<TelegramApiResult<boolean>> {
    return this.call<boolean>("deleteWebhook", {
      drop_pending_updates: dropPending,
    });
  }

  /**
   * Long-poll. Local/dev only — do not use on Vercel production.
   */
  async getUpdates(input?: {
    offset?: number;
    timeout?: number;
    allowedUpdates?: string[];
  }): Promise<TelegramApiResult<TelegramUpdate[]>> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      offset: input?.offset,
      timeout: input?.timeout ?? 0,
      allowed_updates: input?.allowedUpdates ?? ["message", "callback_query"],
    });
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: SendTelegramMessageOptions = {}
  ): Promise<TelegramApiResult> {
    const chunks = splitTelegramText(text, TELEGRAM_TEXT_LIMIT);
    let last: TelegramApiResult = { ok: false, description: "empty text" };
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      last = await this.call("sendMessage", {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: options.parseMode ?? "HTML",
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        ...(isLast && options.replyMarkup
          ? { reply_markup: options.replyMarkup }
          : {}),
      });
      if (!last.ok) return last;
    }
    return last;
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string
  ): Promise<TelegramApiResult<boolean>> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }
}

export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const trimmed = text.length ? text : " ";
  if (trimmed.length <= limit) return [trimmed];
  const parts: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function telegramPersonaFooter(botName?: string): string {
  const name = (botName || "").trim();
  if (!name || name.toLowerCase() === "coordinator") return "";
  return `\n\n[Worker: ${name}]`;
}

export function withPersonaFooter(text: string, botName?: string): string {
  const footer = telegramPersonaFooter(botName);
  if (!footer) return text;
  return `${text}${footer}`;
}

export function telegramWebhookSecretMatches(
  header: string | null | undefined,
  expected: string
): boolean {
  const presented = header || "";
  const want = expected || "";
  if (!want || presented.length !== want.length) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
