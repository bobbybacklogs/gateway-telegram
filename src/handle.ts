import type { GatewayTelegramAdapter } from "./adapter.js";
import type { TelegramUpdate } from "./telegram-api.js";

/** Named helper for hosts that do not want the class. */
export function handleTelegramUpdate(
  adapter: GatewayTelegramAdapter,
  update: TelegramUpdate
) {
  return adapter.handleUpdate(update);
}
