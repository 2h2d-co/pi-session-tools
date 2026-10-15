import type { HandoffInput } from "./schemas.ts";

export type Mode = HandoffInput["mode"];

export const MODES: readonly { mode: Mode; description: string }[] = [
  { mode: "new", description: "Start a fresh session with the message" },
  { mode: "fork", description: "Fork from a checkpoint into a new session" },
  { mode: "navigate", description: "Return to a checkpoint in this session" },
  { mode: "compact", description: "Compact this session, then continue" },
];

export const USAGE =
  "Usage: /session-handoff new|compact <message>, or /session-handoff fork|navigate <checkpoint-id> <message>. Omitted parts are asked for interactively.";

export interface ParsedCommand {
  mode?: Mode;
  targetEntryId?: string;
  text?: string;
}

function isMode(value: string): value is Mode {
  return MODES.some((item) => item.mode === value);
}

/**
 * Parse `<mode> [checkpoint-id] [message]`. The second word of a targeted mode
 * is a checkpoint ID only when it names an existing entry; otherwise it starts
 * the message and the checkpoint is chosen interactively.
 */
export function parseHandoffCommand(args: string, isEntry: (id: string) => boolean): ParsedCommand {
  const words = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (!words) return {};
  const [, mode = "", rest = ""] = words;
  if (!isMode(mode)) throw new Error(USAGE);
  if (mode === "fork" || mode === "navigate") {
    const target = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    const [, id = "", text = ""] = target ?? [];
    if (id && isEntry(id)) {
      return { mode, targetEntryId: id, ...(text.trim() ? { text: text.trim() } : {}) };
    }
  }
  return { mode, ...(rest.trim() ? { text: rest.trim() } : {}) };
}
