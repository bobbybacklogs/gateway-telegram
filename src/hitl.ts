import { randomBytes } from "node:crypto";

/** Compact Telegram HITL token → existing approval-gate ids (callback_data ≤ 64 bytes). */
export interface TelegramHitlEntry {
  token: string;
  requestId: string;
  subagentId: string;
  chatId: number;
  botName?: string;
  taskTitle?: string;
  createdAt: string;
  expiresAt: string;
}

export interface TelegramHitlStore {
  put(
    entry: Omit<TelegramHitlEntry, "token" | "createdAt" | "expiresAt"> & {
      token?: string;
      ttlMs?: number;
      nowMs?: number;
    }
  ): Promise<TelegramHitlEntry>;
  take(token: string, nowMs?: number): Promise<TelegramHitlEntry | null>;
}

export function mintTelegramHitlToken(): string {
  return randomBytes(8).toString("hex");
}

export function telegramCallbackData(
  decision: "approve" | "deny",
  token: string
): string {
  const prefix = decision === "approve" ? "a" : "d";
  const data = `${prefix}:${token}`;
  if (data.length > 64) {
    throw new Error("callback_data exceeds Telegram 64-byte limit");
  }
  return data;
}

export function parseTelegramCallbackData(
  data: string
): { approved: boolean; token: string } | null {
  const match = /^(a|d):([0-9a-f]{16})$/i.exec((data || "").trim());
  if (!match) return null;
  return {
    approved: match[1].toLowerCase() === "a",
    token: match[2].toLowerCase(),
  };
}

/**
 * In-process map (same durability class as gwork approval-gate).
 * Hosts may inject another store; do not use Redis / copied swarm-store.
 */
export class MemoryHitlStore implements TelegramHitlStore {
  private tokens = new Map<string, TelegramHitlEntry>();

  async put(
    entry: Omit<TelegramHitlEntry, "token" | "createdAt" | "expiresAt"> & {
      token?: string;
      ttlMs?: number;
      nowMs?: number;
    }
  ): Promise<TelegramHitlEntry> {
    const nowMs = entry.nowMs ?? Date.now();
    const ttlMs = entry.ttlMs ?? 120_000;
    const token = entry.token || mintTelegramHitlToken();
    this.prune(nowMs);
    const stored: TelegramHitlEntry = {
      token,
      requestId: entry.requestId,
      subagentId: entry.subagentId,
      chatId: entry.chatId,
      botName: entry.botName,
      taskTitle: entry.taskTitle,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    };
    this.tokens.set(token, stored);
    return stored;
  }

  async take(token: string, nowMs = Date.now()): Promise<TelegramHitlEntry | null> {
    this.prune(nowMs);
    const key = token.trim().toLowerCase();
    const found = this.tokens.get(key);
    if (!found) return null;
    this.tokens.delete(key);
    return found;
  }

  private prune(nowMs: number): void {
    for (const [token, entry] of this.tokens) {
      if (Date.parse(entry.expiresAt) <= nowMs) this.tokens.delete(token);
    }
  }
}
