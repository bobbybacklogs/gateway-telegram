import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export function writeSseHeaders(res: ServerResponse): void {
  for (const [key, value] of Object.entries(SSE_HEADERS)) {
    res.setHeader(key, value);
  }
  res.flushHeaders?.();
}

export function writeSseEvent(
  res: ServerResponse,
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function streamSseFromReadable(
  body: Readable,
  res: ServerResponse,
): Promise<void> {
  writeSseHeaders(res);
  await new Promise<void>((resolve, reject) => {
    body.on("data", (chunk: Buffer | string) => {
      res.write(chunk);
    });
    body.on("end", () => resolve());
    body.on("error", reject);
  });
}

export async function writeSseFromJson(
  res: ServerResponse,
  payload: unknown,
): Promise<void> {
  writeSseHeaders(res);
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    writeSseEvent(res, "error", { error: (payload as { error: string }).error });
    writeSseEvent(res, "done", {});
    res.end();
    return;
  }
  const text =
    payload && typeof payload === "object" && "text" in payload
      ? String((payload as { text?: unknown }).text ?? "")
      : "";
  writeSseEvent(res, "meta", { source: "telegram" });
  if (text) {
    writeSseEvent(res, "delta", { text });
  }
  writeSseEvent(res, "done", {});
  res.end();
}

export async function writeSseFromFetchResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  if (!response.body) {
    writeSseHeaders(res);
    writeSseEvent(res, "error", { error: "empty_stream" });
    writeSseEvent(res, "done", {});
    res.end();
    return;
  }
  writeSseHeaders(res);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (error) {
    writeSseEvent(res, "error", {
      error: error instanceof Error ? error.message : String(error),
    });
    writeSseEvent(res, "done", {});
    res.end();
  }
}

export function isSseRequest(req: IncomingMessage): boolean {
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/event-stream");
}
