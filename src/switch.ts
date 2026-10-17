import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseSessionEntries,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { HANDOFF_TYPE, requireCheckpoint } from "./history.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export const NO_SOURCE =
  "No handoff from another session names a checkpoint to return to. Name the session file and checkpoint.";

export interface SwitchTarget {
  /** Absolute path of the saved session file. */
  sessionFile: string;
  entryId: string;
}

function realFile(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The source of the latest handoff on the current branch that came from another session file.
 * Handoffs within this session are skipped, so a later navigate or compact keeps the way back.
 */
export function handoffSource(manager: ReadonlySessionManager): SwitchTarget | undefined {
  const current = manager.getSessionFile();
  for (const entry of manager.getBranch().toReversed()) {
    if (entry.type !== "custom_message" || entry.customType !== HANDOFF_TYPE) continue;
    const details: unknown = entry.details;
    if (typeof details !== "object" || details === null || !("origin" in details)) continue;
    const origin: unknown = details.origin;
    if (
      typeof origin === "object" &&
      origin !== null &&
      "sessionFile" in origin &&
      "entryId" in origin &&
      typeof origin.sessionFile === "string" &&
      typeof origin.entryId === "string" &&
      origin.sessionFile !== current
    ) {
      return { sessionFile: origin.sessionFile, entryId: origin.entryId };
    }
  }
  return undefined;
}

/**
 * The absolute path when `requested` names an existing regular file. The path keeps its symlinks,
 * as Pi's own session paths do; only identity checks compare canonical paths.
 */
export function existingFile(requested: string, cwd: string): string | undefined {
  const path = resolve(cwd, requested);
  const real = realFile(path);
  return real && statSync(real).isFile() ? path : undefined;
}

/**
 * Read a saved session other than the current one, in the same working directory. The file is
 * parsed into an in-memory copy, so neither validation nor Pi's format migration writes to it.
 */
export function openSession(
  requested: string,
  cwd: string,
  currentFile: string | undefined,
): { sessionFile: string; manager: SessionManager } {
  const sessionFile = existingFile(requested, cwd);
  if (!sessionFile) throw new Error("The target session file does not exist.");
  if (currentFile && realFile(currentFile) === realFile(sessionFile)) {
    throw new Error("The target is the current session. Use navigate instead.");
  }
  const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
  const header = entries.find(
    // Malformed lines can parse to null or other non-entry JSON values.
    (entry: unknown) =>
      typeof entry === "object" && entry !== null && "type" in entry && entry.type === "session",
  );
  if (header?.type !== "session") throw new Error("The target is not a saved Pi session file.");
  if (!header.cwd || resolve(header.cwd) !== resolve(cwd)) {
    throw new Error("The target session belongs to another working directory.");
  }
  return { sessionFile, manager: SessionManager.inMemory(header.cwd, undefined, entries) };
}

/** Resolve and check a switch destination: a valid checkpoint in another saved session. */
export function switchTarget(
  manager: ReadonlySessionManager,
  cwd: string,
  requested?: { sessionFile: string; entryId: string },
): SwitchTarget {
  const target = requested ?? handoffSource(manager);
  if (!target) throw new Error(NO_SOURCE);
  const opened = openSession(target.sessionFile, cwd, manager.getSessionFile());
  requireCheckpoint(opened.manager, target.entryId);
  return { sessionFile: opened.sessionFile, entryId: target.entryId };
}
