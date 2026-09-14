export type TelegramSseHandlers = {
  onAssistantText: (text: string, worker?: string) => Promise<void>;
  onApprovalPending: (info: {
    requestId: string;
    subagentId: string;
    botName?: string;
    taskTitle?: string;
  }) => Promise<void>;
  onMentionSkip?: (info: {
    name: string;
    reason: string;
    detail?: string;
  }) => Promise<void>;
};

export async function consumeAgentSse(
  response: Response,
  handlers: TelegramSseHandlers
): Promise<{ requestId?: string }> {
  if (!response.body) {
    const text = await response.text().catch(() => "");
    if (text) await handlers.onAssistantText(text);
    return {};
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let requestId: string | undefined;
  let turnBuf = "";
  let turnWorker: string | undefined;
  const seenApprovals = new Set<string>();
  const subBuf = new Map<string, { text: string; botName?: string }>();

  const flushTurn = async () => {
    const text = turnBuf.trim();
    turnBuf = "";
    if (text) await handlers.onAssistantText(text, turnWorker);
  };

  const handleEvent = async (raw: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof event.requestId === "string") requestId = event.requestId;
    const type = String(event.type || "");
    const botName =
      typeof event.botName === "string" ? event.botName : undefined;
    const subagent =
      event.subagent && typeof event.subagent === "object"
        ? (event.subagent as Record<string, unknown>)
        : undefined;
    const subId =
      (typeof event.subagentId === "string" && event.subagentId) ||
      (typeof subagent?.id === "string" ? subagent.id : undefined);

    switch (type) {
      case "turn_chunk":
      case "turn_followup_chunk":
        if (typeof event.chunk === "string") turnBuf += event.chunk;
        if (botName) turnWorker = botName;
        break;
      case "turn_complete":
        await flushTurn();
        break;
      case "subagent_start": {
        const status = String(subagent?.status || event.status || "");
        const step = String(subagent?.activeStep || event.activeStep || "");
        const pending =
          status === "pending" || /awaiting approval/i.test(step);
        if (pending && requestId && subId && !seenApprovals.has(subId)) {
          seenApprovals.add(subId);
          await handlers.onApprovalPending({
            requestId,
            subagentId: subId,
            botName:
              (typeof subagent?.botName === "string" && subagent.botName) ||
              botName,
            taskTitle:
              typeof subagent?.taskTitle === "string"
                ? subagent.taskTitle
                : undefined,
          });
        }
        break;
      }
      case "subagent_chunk":
        if (subId && typeof event.chunk === "string") {
          const cur = subBuf.get(subId) || {
            text: "",
            botName:
              (typeof subagent?.botName === "string" && subagent.botName) ||
              botName,
          };
          cur.text += event.chunk;
          subBuf.set(subId, cur);
        }
        break;
      case "subagent_complete": {
        if (subId) {
          const cur = subBuf.get(subId);
          const output =
            (typeof subagent?.output === "string" && subagent.output) ||
            cur?.text ||
            "";
          const worker =
            (typeof subagent?.botName === "string" && subagent.botName) ||
            cur?.botName ||
            botName;
          if (output.trim()) {
            await handlers.onAssistantText(output.trim(), worker);
          }
          subBuf.delete(subId);
        }
        break;
      }
      case "mention_skip": {
        const mention = event.mention as
          | { name?: string; reason?: string; detail?: string }
          | undefined;
        if (mention?.name && handlers.onMentionSkip) {
          await handlers.onMentionSkip({
            name: mention.name,
            reason: mention.reason || "skipped",
            detail: mention.detail,
          });
        }
        break;
      }
      case "done":
        await flushTurn();
        break;
      default:
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      const raw = dataLines.join("\n");
      if (raw) await handleEvent(raw);
    }
  }
  if (buffer.trim()) {
    const dataLines = buffer
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    const raw = dataLines.join("\n");
    if (raw) await handleEvent(raw);
  }
  await flushTurn();
  return { requestId };
}
