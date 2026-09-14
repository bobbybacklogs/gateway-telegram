import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readRegistry } from "gateway-workers";
import {
  GatewayTelegramAdapter,
  parseTelegramCommand,
  telegramOffered,
  TELEGRAM_SUBAGENT_CAP,
  TELEGRAM_A2A_DEPTH_CAP,
} from "../dist/index.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe("In-process Telegram adapter (no Gateway HTTP sidecar)", () => {
  it("1. Caps come from gateway-workers, not a second runtime", () => {
    assert.equal(TELEGRAM_SUBAGENT_CAP, 3);
    assert.equal(TELEGRAM_A2A_DEPTH_CAP, 2);
    assert.equal(telegramOffered({ TELEGRAM_BOT_TOKEN: "" }), false);
    assert.equal(parseTelegramCommand("/hire A | B").kind, "hire");
  });

  it("2. /hire calls upsertBot in-process (no /api/swarm fetch)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tg-inproc-hire-"));
    try {
      const telegramUrls = [];
      const adapter = new GatewayTelegramAdapter({
        botToken: "123:test",
        webhookSecret: "sec",
        rootDir: tempDir,
        fetch: async (url, init) => {
          telegramUrls.push(String(url));
          return jsonResponse({ ok: true, result: true });
        },
        orchestrateChat: () => {
          throw new Error("chat should not run for /hire");
        },
      });
      const result = await adapter.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 9 },
          text: "/hire Ledger | Own month-end. Never invent numbers.",
        },
      });
      assert.equal(result.action, "hire");
      const registry = await readRegistry(tempDir);
      assert.ok(
        Object.values(registry).some((b) =>
          String(b.name).toLowerCase().includes("ledger")
        )
      );
      assert.ok(telegramUrls.every((u) => u.includes("api.telegram.org")));
      assert.ok(telegramUrls.every((u) => !u.includes("/api/chat")));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("3. Chat text calls orchestrateChat in-process, never fetch /api/chat", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tg-inproc-chat-"));
    try {
      const fetches = [];
      let orchestrateCalled = 0;
      const sse =
        `data: ${JSON.stringify({
          type: "turn_chunk",
          chunk: "ok",
          requestId: "chat_inproc",
        })}\n\n` +
        `data: ${JSON.stringify({ type: "done", requestId: "chat_inproc" })}\n\n`;
      const adapter = new GatewayTelegramAdapter({
        botToken: "123:test",
        rootDir: tempDir,
        fetch: async (url) => {
          fetches.push(String(url));
          return jsonResponse({ ok: true, result: true });
        },
        orchestrateChat: (input) => {
          orchestrateCalled += 1;
          assert.equal(input.botId, "coordinator");
          assert.equal(input.maxParallel, 3);
          assert.equal(input.messages[0].content, "@developer ship it");
          return new Response(sse, { status: 200 });
        },
      });
      const result = await adapter.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          chat: { id: 4 },
          text: "@developer ship it",
        },
      });
      assert.equal(result.action, "chat");
      assert.equal(orchestrateCalled, 1);
      assert.ok(fetches.every((u) => u.includes("api.telegram.org")));
      assert.equal(
        fetches.some((u) => u.includes("/api/chat")),
        false
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("4. Requires rootDir so hire/A2A have a workspace without a running gwork", () => {
    assert.throws(
      () =>
        new GatewayTelegramAdapter({
          botToken: "123:test",
          rootDir: "",
        }),
      /rootDir/
    );
  });
});
