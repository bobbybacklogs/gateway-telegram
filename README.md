# gateway-telegram

In-process Telegram channel for **Gateway Workers**. Other apps **import this library** and mount a webhook on **their** process. One `TELEGRAM_BOT_TOKEN`. Hire, A2A, skills, subagents, tools, and approval run as **`gateway-workers` function calls in the same Node process**.

This is **not** a sidecar. You do **not** `npm run dev` gwork (or any Gateway HTTP server) for Telegram orchestrations.

A2A / `orchestrateChat` / approval-gate live in `gateway-workers`. This repo does **not** copy `swarm-store.ts`, `orchestrate.ts`, or `a2a.ts`.

## Install

Clone next to `Gateway-Workers` (or depend on that package however you already consume it):

```bash
npm install @bobbybacklogs/gateway-telegram
npm install gateway-workers   # workspace / git / file: path to packages/gateway-workers
```

## Host app (thin route)

```ts
import { GatewayTelegramAdapter, createTelegramWebhookHandler } from "@bobbybacklogs/gateway-telegram";

const adapter = new GatewayTelegramAdapter({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
  rootDir: process.env.GWORK_SWARM_WORKSPACE || process.cwd(),
});

export const POST = createTelegramWebhookHandler(adapter);
```

Set `GWORK_SWARM_WORKSPACE` to the swarm workspace `rootDir` (registry/office). Model keys (`AI_GATEWAY_API_KEY`, etc.) are whatever `orchestrateChat` already needs — still **in this process**, not another server.

`POST /api/chat` on gwork is an optional UI host. The SDK does not fetch it.

## Maps

| Telegram | Library call |
| --- | --- |
| Chat / `@mentions` | `orchestrateChat({ messages, maxParallel: 3 })` |
| `/hire` `/retire` `/directory` | `upsertBot` / `retireBot` / `readRegistry` |
| `/routine` `/learn` `/skills` | same `orchestrateChat` (eve tools stay on the host process) |
| Approve / Deny | `resolveSubagentApproval` (in-memory, same isolate) |

Caps: `MAX_PARALLEL_SUBAGENTS = 3`, `MAX_A2A_MENTION_DEPTH = 2` (imported, not raised). Footer `[Worker: …]`. `callback_data` ≤ 64 bytes.

## Out of scope

LangGraph, Redis, Postgres, Mini Apps, BotFather multi-token, local `telegram-bot-api`, copied swarm, HTTP-only `GatewayWorkersClient` → `/api/chat`.
