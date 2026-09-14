export type TelegramCommand =
  | { kind: "help" }
  | { kind: "hire"; name: string; instructions: string }
  | { kind: "retire"; botId: string; hard: boolean }
  | { kind: "directory" }
  | { kind: "tasks"; forBot?: string }
  | { kind: "skills" }
  | { kind: "routine"; slug: string; extra: string }
  | { kind: "learn"; demonstration: string }
  | { kind: "chat"; text: string };

export function parseTelegramCommand(text: string): TelegramCommand {
  const raw = text.replace(/^\s+/, "");
  const match = /^\/([a-zA-Z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(raw);
  if (!match) return { kind: "chat", text: raw };

  const name = match[1].toLowerCase();
  const rest = (match[2] || "").trim();

  switch (name) {
    case "start":
    case "help":
      return { kind: "help" };
    case "hire": {
      const pipe = rest.split("|");
      const hireName = (pipe[0] || "").trim();
      const instructions = pipe.slice(1).join("|").trim();
      return { kind: "hire", name: hireName, instructions };
    }
    case "retire": {
      const parts = rest.split(/\s+/).filter(Boolean);
      const hard = parts.includes("hard") || parts.includes("--hard");
      const botId = parts.find((p) => p !== "hard" && p !== "--hard") || "";
      return { kind: "retire", botId, hard };
    }
    case "directory":
    case "bots":
      return { kind: "directory" };
    case "tasks":
      return { kind: "tasks", forBot: rest || undefined };
    case "skills":
      return { kind: "skills" };
    case "routine": {
      const [slug, ...extra] = rest.split(/\s+/);
      return { kind: "routine", slug: slug || "", extra: extra.join(" ") };
    }
    case "learn":
      return { kind: "learn", demonstration: rest };
    default:
      return { kind: "chat", text: raw };
  }
}

export function helpText(): string {
  return [
    "Gateway Workers via Telegram (one bot token).",
    "",
    "Chat text runs orchestrateChat in this process (A2A / tools / approval).",
    "Caps: 3 parallel subagents, A2A depth 2. No Gateway sidecar.",
    "",
    "/hire Name | instructions — upsertBot",
    "/retire botId [hard] — retireBot",
    "/directory — swarm roster",
    "/tasks [forBot] — bot-to-bot tasks",
    "/skills — ask host eve for SKILL.md names",
    "/routine slug — ask coordinator to run_routine",
    "/learn … — ask coordinator to learn_demonstrated_routine",
    "",
    "Subagent work asks Approve / Deny here (host approval-gate).",
  ].join("\n");
}
