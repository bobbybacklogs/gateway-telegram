/**
 * In-process Telegram adapter. Calls gateway-workers library APIs in this
 * process. Does not fetch /api/chat or require npm run dev.
 */

import {
  MAX_A2A_MENTION_DEPTH,
  MAX_PARALLEL_SUBAGENTS,
  orchestrateChat,
  readRegistry,
  resolveSubagentApproval,
  retireBot,
  upsertBot,
  type ChatMessage,
  type SwarmBot,
} from "gateway-workers";
import {
  TelegramBotApi,
  escapeTelegramHtml,
  telegramWebhookSecretMatches,
  withPersonaFooter,
  type TelegramUpdate,
} from "./telegram-api.js";
import { helpText, parseTelegramCommand } from "./commands.js";
import {
  MemoryHitlStore,
  parseTelegramCallbackData,
  telegramCallbackData,
  type TelegramHitlStore,
} from "./hitl.js";
import { consumeAgentSse } from "./sse.js";

export const TELEGRAM_SUBAGENT_CAP = MAX_PARALLEL_SUBAGENTS;
export const TELEGRAM_A2A_DEPTH_CAP = MAX_A2A_MENTION_DEPTH;

export type OrchestrateChatFn = (input: {
  messages: ChatMessage[];
  botId?: string;
  maxParallel?: number;
  autoApproveSubagents?: boolean;
}) => Response;

export type GatewayTelegramAdapterOptions = {
  botToken: string;
  webhookSecret?: string;
  /** Swarm workspace root (same as upsertBot rootDir). */
  rootDir: string;
  fetch?: typeof globalThis.fetch;
  api?: TelegramBotApi;
  hitlStore?: TelegramHitlStore;
  skillsDir?: string;
  orchestrateChat?: OrchestrateChatFn;
  autoApproveSubagents?: boolean;
};

export function telegramOffered(
  env: { TELEGRAM_BOT_TOKEN?: string } = typeof process !== "undefined"
    ? process.env
    : {}
): boolean {
  return Boolean((env.TELEGRAM_BOT_TOKEN || "").trim());
}

export class GatewayTelegramAdapter {
  readonly api: TelegramBotApi;
  readonly webhookSecret: string;
  readonly rootDir: string;
  readonly skillsDir?: string;
  private hitl: TelegramHitlStore;
  private orchestrateFn: OrchestrateChatFn;
  private autoApproveSubagents: boolean;

  constructor(options: GatewayTelegramAdapterOptions) {
    if (!(options.rootDir || "").trim()) {
      throw new Error("rootDir is required (in-process swarm workspace).");
    }
    this.rootDir = options.rootDir;
    if (!process.env.GWORK_SWARM_WORKSPACE) {
      process.env.GWORK_SWARM_WORKSPACE = options.rootDir;
    }
    this.api =
      options.api ||
      new TelegramBotApi({
        botToken: options.botToken,
        fetch: options.fetch || globalThis.fetch.bind(globalThis),
      });
    this.webhookSecret = (options.webhookSecret || "").trim();
    this.skillsDir = options.skillsDir;
    this.hitl = options.hitlStore || new MemoryHitlStore();
    this.orchestrateFn = options.orchestrateChat || orchestrateChat;
    this.autoApproveSubagents = Boolean(options.autoApproveSubagents);
  }

  verifyWebhookSecret(header: string | null | undefined): boolean {
    if (!this.webhookSecret) return false;
    return telegramWebhookSecretMatches(header, this.webhookSecret);
  }

  setWebhook(url: string) {
    return this.api.setWebhook({
      url,
      secretToken: this.webhookSecret || undefined,
    });
  }

  async handleUpdate(
    update: TelegramUpdate
  ): Promise<{ ok: boolean; action: string }> {
    if (update.callback_query) return this.handleCallback(update);
    const message = update.message || update.edited_message;
    if (!message?.chat?.id) return { ok: true, action: "ignored" };
    const text = (message.text || message.caption || "").trim();
    if (!text) return { ok: true, action: "ignored" };
    return this.handleText(message.chat.id, text);
  }

  private async handleCallback(
    update: TelegramUpdate
  ): Promise<{ ok: boolean; action: string }> {
    const cq = update.callback_query!;
    const parsed = parseTelegramCallbackData(cq.data || "");
    await this.api.answerCallbackQuery(cq.id);
    const chatId = cq.message?.chat.id;
    if (!parsed || chatId == null) {
      if (chatId != null) {
        await this.reply(chatId, "This approval token is unknown or expired.");
      }
      return { ok: false, action: "callback_unknown" };
    }
    const entry = await this.hitl.take(parsed.token);
    if (!entry) {
      await this.reply(chatId, "This approval token is unknown or expired.");
      return { ok: false, action: "callback_expired" };
    }
    const result = resolveSubagentApproval({
      requestId: entry.requestId,
      subagentId: entry.subagentId,
      approved: parsed.approved,
    });
    await this.reply(
      chatId,
      result.ok
        ? parsed.approved
          ? `Approved ${entry.subagentId}.`
          : `Denied ${entry.subagentId}.`
        : `Approval failed: ${"reason" in result ? result.reason : "unknown"}`
    );
    return { ok: result.ok, action: parsed.approved ? "approved" : "denied" };
  }

  private async handleText(
    chatId: number,
    text: string
  ): Promise<{ ok: boolean; action: string }> {
    const command = parseTelegramCommand(text);
    switch (command.kind) {
      case "help":
        await this.reply(chatId, helpText());
        return { ok: true, action: "help" };
      case "hire": {
        if (!command.name || !command.instructions) {
          await this.reply(
            chatId,
            "Usage: /hire Name | job instructions (upsertBot)."
          );
          return { ok: false, action: "hire_usage" };
        }
        try {
          const bot = await upsertBot(this.rootDir, {
            name: command.name,
            displayName: command.name,
            role:
              command.instructions.slice(0, 80) ||
              `Custom specialist (${command.name})`,
            instructions: command.instructions,
            capabilities: ["autonomous_worker", "domain_expert"],
          });
          await this.reply(
            chatId,
            `Hired @${bot.name} via upsertBot (same swarm-store, in-process).`
          );
          return { ok: true, action: "hire" };
        } catch (err) {
          await this.reply(chatId, errMessage(err));
          return { ok: false, action: "hire_error" };
        }
      }
      case "retire": {
        if (!command.botId) {
          await this.reply(chatId, "Usage: /retire botId [hard]");
          return { ok: false, action: "retire_usage" };
        }
        try {
          const result = await retireBot(this.rootDir, command.botId, {
            hard: command.hard,
          });
          await this.reply(chatId, result.message);
          return { ok: true, action: "retire" };
        } catch (err) {
          await this.reply(chatId, errMessage(err));
          return { ok: false, action: "retire_error" };
        }
      }
      case "directory": {
        const registry = await readRegistry(this.rootDir);
        const bots = Object.values(registry).filter(
          (b: SwarmBot) => b.status !== "retired"
        );
        const lines = bots.map(
          (b: SwarmBot) =>
            `• @${b.name} (${b.status}) — ${b.role || b.description || ""}`
        );
        await this.reply(
          chatId,
          lines.length ? lines.join("\n") : "No bots in the swarm registry."
        );
        return { ok: true, action: "directory" };
      }
      case "tasks":
        await this.runCoordinatorChat(
          chatId,
          "List current bot-to-bot tasks from existing Gateway state."
        );
        return { ok: true, action: "tasks" };
      case "skills":
        await this.runCoordinatorChat(
          chatId,
          "List the skills available to you from existing SKILL.md / eve tools. Do not invent a Telegram skill store."
        );
        return { ok: true, action: "skills" };
      case "routine": {
        if (!command.slug) {
          await this.reply(chatId, "Usage: /routine slug");
          return { ok: false, action: "routine_usage" };
        }
        await this.runCoordinatorChat(
          chatId,
          [
            "Use the existing run_routine tool.",
            `routineSlug: ${command.slug}`,
            command.extra ? `notes: ${command.extra}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
        return { ok: true, action: "routine" };
      }
      case "learn": {
        if (!command.demonstration) {
          await this.reply(
            chatId,
            "Usage: /learn <demonstration for learn_demonstrated_routine>"
          );
          return { ok: false, action: "learn_usage" };
        }
        await this.runCoordinatorChat(
          chatId,
          [
            "Use the existing learn_demonstrated_routine tool with this demonstration.",
            command.demonstration,
          ].join("\n")
        );
        return { ok: true, action: "learn" };
      }
      case "chat":
        await this.runCoordinatorChat(chatId, command.text);
        return { ok: true, action: "chat" };
      default: {
        const _never: never = command;
        throw new Error(`Unhandled Telegram command: ${JSON.stringify(_never)}`);
      }
    }
  }

  private async runCoordinatorChat(chatId: number, text: string): Promise<void> {
    const response = this.orchestrateFn({
      messages: [{ role: "user", content: text }],
      botId: "coordinator",
      maxParallel: TELEGRAM_SUBAGENT_CAP,
      autoApproveSubagents: this.autoApproveSubagents,
    });

    await consumeAgentSse(response, {
      onAssistantText: async (body, worker) => {
        await this.reply(chatId, withPersonaFooter(body, worker));
      },
      onApprovalPending: async (info) => {
        const stored = await this.hitl.put({
          requestId: info.requestId,
          subagentId: info.subagentId,
          chatId,
          botName: info.botName,
          taskTitle: info.taskTitle,
        });
        const prompt = [
          `Approve @${info.botName || "teammate"}`,
          info.taskTitle ? `Task: ${info.taskTitle}` : "",
          `id: ${info.subagentId}`,
        ]
          .filter(Boolean)
          .join("\n");
        await this.api.sendMessage(chatId, escapeTelegramHtml(prompt), {
          parseMode: "HTML",
          replyMarkup: {
            inline_keyboard: [
              [
                {
                  text: "Approve",
                  callback_data: telegramCallbackData("approve", stored.token),
                },
                {
                  text: "Deny",
                  callback_data: telegramCallbackData("deny", stored.token),
                },
              ],
            ],
          },
        });
      },
      onMentionSkip: async (mention) => {
        await this.reply(
          chatId,
          `A2A skip @${mention.name}: ${mention.reason}${
            mention.detail ? ` (${mention.detail})` : ""
          }`
        );
      },
    });
  }

  private async reply(chatId: number, text: string): Promise<void> {
    await this.api.sendMessage(chatId, escapeTelegramHtml(text), {
      parseMode: "HTML",
    });
  }
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message || err);
  }
  return String(err || "error");
}
