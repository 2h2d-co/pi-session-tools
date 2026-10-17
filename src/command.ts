import type { HandoffInput } from "./schemas.ts";

export type Mode = HandoffInput["mode"];

export const MODES: readonly { mode: Mode; description: string }[] = [
  { mode: "new", description: "Start a fresh session with the message" },
  { mode: "fork", description: "Fork from a checkpoint into a new session" },
  { mode: "navigate", description: "Return to a checkpoint in this session" },
  { mode: "compact", description: "Compact this session, then continue" },
  { mode: "switch", description: "Return to a checkpoint in another saved session" },
];

export const USAGE =
  "Usage: /handoff new|compact <message>, /handoff fork|navigate <checkpoint-id> <message>, or /handoff switch [<session-file> <checkpoint-id>] <message>. Omitted parts are asked for interactively.";

export interface ParsedCommand {
  mode?: Mode;
  targetSessionFile?: string;
  targetEntryId?: string;
  text?: string;
}

export interface CommandTargets {
  /** Whether `id` names an entry in `sessionFile`, or in the current session when omitted. */
  isEntry: (id: string, sessionFile?: string) => boolean;
  /** Whether `path` names an existing file. */
  isFile: (path: string) => boolean;
}

function isMode(value: string): value is Mode {
  return MODES.some((item) => item.mode === value);
}

/** Split off the first word. A double-quoted word may hold spaces, as session paths can. */
function firstWord(text: string): { word: string; rest: string } | undefined {
  const words = /^(?:"([^"]*)"|(\S+))(?:\s+([\s\S]*))?$/.exec(text);
  return words ? { word: words[1] ?? words[2] ?? "", rest: words[3] ?? "" } : undefined;
}

function withText(parsed: ParsedCommand, text: string): ParsedCommand {
  return text.trim() ? { ...parsed, text: text.trim() } : parsed;
}

/**
 * Parse `<mode> [target] [message]`. A target word counts only when it names an existing file or
 * entry; otherwise it starts the message and the target is chosen later.
 */
export function parseHandoffCommand(args: string, targets: CommandTargets): ParsedCommand {
  const words = firstWord(args.trim());
  if (!words) return {};
  const { word: mode, rest } = words;
  if (!isMode(mode)) throw new Error(USAGE);
  if (mode === "fork" || mode === "navigate") {
    const target = firstWord(rest);
    if (target && targets.isEntry(target.word)) {
      return withText({ mode, targetEntryId: target.word }, target.rest);
    }
  }
  if (mode === "switch") {
    const file = firstWord(rest);
    if (file && targets.isFile(file.word)) {
      const parsed = { mode, targetSessionFile: file.word };
      const target = firstWord(file.rest);
      if (target && targets.isEntry(target.word, file.word)) {
        return withText({ ...parsed, targetEntryId: target.word }, target.rest);
      }
      return withText(parsed, file.rest);
    }
  }
  return withText({ mode }, rest);
}
