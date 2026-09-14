import {
  GatewayTelegramAdapter,
  createTelegramWebhookHandler,
  parseTelegramOperatorAllowlist,
} from "../src/index.js";

/**
 * Example host route (Next / Hono / plain fetch).
 * This file is documentation — copy into your app. Not a Gateway server.
 */
export function exampleWebhookPost() {
  const adapter = new GatewayTelegramAdapter({
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
    allowedChatIds: parseTelegramOperatorAllowlist(
      process.env.TELEGRAM_ALLOWED_CHAT_IDS
    ),
    rootDir: process.env.GWORK_SWARM_WORKSPACE || process.cwd(),
  });
  return createTelegramWebhookHandler(adapter);
}
