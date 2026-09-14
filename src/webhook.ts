import type { GatewayTelegramAdapter } from "./adapter.js";
import type { TelegramUpdate } from "./telegram-api.js";

/**
 * Fetch-handler for the host app. Runs handleUpdate in this process.
 * Does not proxy to a Gateway HTTP server.
 */
export function createTelegramWebhookHandler(adapter: GatewayTelegramAdapter) {
  return async (req: Request): Promise<Response> => {
    if (!adapter.verifyWebhookSecret(req.headers.get("x-telegram-bot-api-secret-token"))) {
      return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
    }
    let update: TelegramUpdate;
    try {
      update = (await req.json()) as TelegramUpdate;
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
    }
    await adapter.handleUpdate(update);
    return Response.json({ ok: true });
  };
}
