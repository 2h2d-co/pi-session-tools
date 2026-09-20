import { createHash } from "node:crypto";
import { renderSystemMessageUpdate } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { InspectInput } from "./schemas.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export const CHECKPOINT_TYPE = "pi-session-tools:checkpoint";
export const HANDOFF_TYPE = "pi-session-tools:handoff";
export const JOURNAL_TYPE = "pi-session-tools:operation";

interface PathState {
  pending: ReadonlyMap<string, string>;
  valid: boolean;
  checkpoint: string | null;
  assistantId: string | null;
  eligible: boolean;
}

export interface Checkpoint {
  entry: SessionMessageEntry;
  parentCheckpointId: string | null;
  assistantId: string;
}

/** Reconstruct boundaries from the append-only tree, including inactive branches. */
export function checkpoints(entries: readonly SessionEntry[]): Map<string, Checkpoint> {
  const states = new Map<string, PathState>();
  const result = new Map<string, Checkpoint>();
  const root: PathState = {
    pending: new Map(),
    valid: true,
    checkpoint: null,
    assistantId: null,
    eligible: false,
  };
  for (const entry of entries) {
    const parent = entry.parentId === null ? root : states.get(entry.parentId);
    if (!parent) continue;
    const next = advance(entry, parent);
    if (
      entry.type === "message" &&
      next.valid &&
      next.eligible &&
      next.pending.size === 0 &&
      next.assistantId
    ) {
      const { message } = entry;
      if (
        (message.role === "assistant" &&
          message.stopReason === "stop" &&
          !message.content.some((block) => block.type === "toolCall")) ||
        (message.role === "toolResult" && parent.pending.has(message.toolCallId))
      ) {
        result.set(entry.id, {
          entry,
          parentCheckpointId: parent.checkpoint,
          assistantId: next.assistantId,
        });
        next.checkpoint = entry.id;
      }
    }
    states.set(entry.id, next);
  }
  return result;
}

function advance(entry: SessionEntry, parent: PathState): PathState {
  const next: PathState = { ...parent };
  if (entry.type === "custom_message" && parent.pending.size !== 0) {
    next.valid = false;
  }
  if (entry.type !== "message") return next;
  const { message } = entry;
  if (message.role === "assistant") {
    // Pi's provider transform excludes incomplete error/abort responses from replay.
    if (message.stopReason === "error" || message.stopReason === "aborted") return next;
    const calls = message.content.filter((block) => block.type === "toolCall");
    const pending = new Map(calls.map((call) => [call.id, call.name]));
    next.valid = parent.valid && parent.pending.size === 0 && pending.size === calls.length;
    next.pending = pending;
    next.assistantId = entry.id;
    next.eligible = message.stopReason === "toolUse" || message.stopReason === "stop";
  } else if (message.role === "toolResult") {
    const pending = new Map(parent.pending);
    next.valid = parent.valid && pending.get(message.toolCallId) === message.toolName;
    pending.delete(message.toolCallId);
    next.pending = pending;
  } else if ((message.role === "user" || message.role === "system") && parent.pending.size !== 0) {
    next.valid = false;
  }
  return next;
}

export function requireCheckpoint(manager: ReadonlySessionManager, entryId: string): Checkpoint {
  const entries = manager.getEntries();
  const checkpoint = checkpoints(entries).get(entryId);
  if (!checkpoint) {
    throw new Error("Target is not a completed turn. Use session_inspect to find a checkpoint.");
  }
  assertReplay(entries, entryId);
  return checkpoint;
}

function assertReplay(entries: SessionEntry[], entryId: string): void {
  // Check the actual compaction-aware replay as well as the raw tree.
  const pending = new Map<string, string>();
  for (const message of buildSessionContext(entries, entryId).messages) {
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      if (pending.size !== 0) throw new Error("Target context contains an unfinished tool batch.");
      for (const block of message.content) {
        if (block.type === "toolCall") pending.set(block.id, block.name);
      }
    } else if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName) {
        throw new Error("Target context contains an unmatched tool result.");
      }
      pending.delete(message.toolCallId);
    } else if (
      pending.size !== 0 &&
      (message.role === "user" || message.role === "custom" || message.role === "system")
    ) {
      throw new Error("Target context interrupts a tool batch.");
    }
  }
  if (pending.size !== 0) throw new Error("Target context contains an unfinished tool batch.");
}

export function lastCheckpoint(manager: ReadonlySessionManager): Checkpoint | undefined {
  const index = checkpoints(manager.getEntries());
  return manager
    .getBranch()
    .toReversed()
    .map((entry) => index.get(entry.id))
    .find((entry) => entry !== undefined);
}

/** Text only: never expose model reasoning, images, tool arguments, or extension state. */
export function entryText(entry: SessionEntry, includeToolResults = false): string {
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
  if (entry.type === "custom_message") {
    if (entry.customType === CHECKPOINT_TYPE) return "";
    return textContent(entry.content);
  }
  if (entry.type !== "message") return "";
  const { message } = entry;
  if (message.role === "system") {
    return [
      renderSystemMessageUpdate(message),
      ...(message.toolsAdded?.map((tool) => `[tool added: ${tool.name}]`) ?? []),
      ...(message.toolsRemoved?.map((tool) => `[tool removed: ${tool.name}]`) ?? []),
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (message.role === "assistant") {
    return message.content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "toolCall") return `[tool: ${block.name}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (message.role === "toolResult" && !includeToolResults) {
    return `[${message.toolName}: ${message.isError ? "error" : "completed"}; output omitted]`;
  }
  if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
    return textContent(message.content);
  }
  return "";
}

function textContent(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

interface Cursor {
  sessionId: string;
  throughId: string;
  anchorId: string | null;
  offset: number;
  signature: string;
}

function pageCursor(manager: ReadonlySessionManager, input: InspectInput): Cursor {
  const { cursor } = input;
  const query = [
    input.view,
    input.entryId ?? null,
    input.query ?? null,
    input.limit ?? 20,
    input.before ?? 2,
    input.after ?? 2,
    input.includeToolResults ?? false,
  ];
  const signature = createHash("sha256").update(JSON.stringify(query)).digest("hex");
  const entries = manager.getEntries();
  if (!cursor) {
    return {
      sessionId: manager.getSessionId(),
      throughId: entries.at(-1)?.id ?? "",
      anchorId: input.entryId ?? manager.getLeafId(),
      offset: 0,
      signature,
    };
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "sessionId" in value &&
      typeof value.sessionId === "string" &&
      value.sessionId === manager.getSessionId() &&
      "signature" in value &&
      value.signature === signature &&
      "throughId" in value &&
      typeof value.throughId === "string" &&
      manager.getEntry(value.throughId) &&
      "anchorId" in value &&
      (value.anchorId === null || typeof value.anchorId === "string") &&
      "offset" in value &&
      typeof value.offset === "number" &&
      Number.isSafeInteger(value.offset) &&
      value.offset >= 0
    ) {
      return {
        sessionId: value.sessionId,
        signature: value.signature,
        throughId: value.throughId,
        anchorId: value.anchorId,
        offset: value.offset,
      };
    }
  } catch (error) {
    throw new Error("Invalid cursor encoding.", { cause: error });
  }
  throw new Error("Invalid cursor. Reuse the same query and session, or start without a cursor.");
}

function nextCursor(cursor: Cursor, offset: number): string {
  return Buffer.from(JSON.stringify({ ...cursor, offset })).toString("base64url");
}

export function inspectSession(manager: ReadonlySessionManager, input: InspectInput): unknown {
  if (input.view === "search" && !input.query?.trim()) {
    throw new Error("Search requires query.");
  }
  if (input.view === "read" && !input.entryId) throw new Error("Read requires entryId.");
  if (input.entryId && !manager.getEntry(input.entryId)) throw new Error("Entry not found.");
  const cursor = pageCursor(manager, input);
  const all = manager.getEntries();
  const through = all.findIndex((entry) => entry.id === cursor.throughId);
  const entries = all.slice(0, through + 1);
  const index = checkpoints(entries);
  const anchorPath = cursor.anchorId ? manager.getBranch(cursor.anchorId) : [];
  const ancestors = new Set(anchorPath.map((entry) => entry.id));
  const anchorCheckpoint = anchorPath.toReversed().find((entry) => index.has(entry.id))?.id ?? null;
  const describe = (checkpoint: Checkpoint) => {
    const { entry } = checkpoint;
    let unavailableReason: string | null = null;
    try {
      assertReplay(entries, entry.id);
    } catch (error) {
      unavailableReason =
        error instanceof Error ? error.message : "Target context cannot be replayed.";
    }
    const descendant = cursor.anchorId
      ? manager.getBranch(entry.id).some((ancestor) => ancestor.id === cursor.anchorId)
      : true;
    return {
      entryId: entry.id,
      parentEntryId: entry.parentId,
      parentCheckpointId: checkpoint.parentCheckpointId,
      timestamp: entry.timestamp,
      role: entry.message.role,
      label: manager.getLabel(entry.id) ?? null,
      preview: entryText(entry, input.includeToolResults).slice(0, 240),
      relation:
        entry.id === cursor.anchorId
          ? "self"
          : ancestors.has(entry.id)
            ? "ancestor"
            : descendant
              ? "descendant"
              : "other-branch",
      retained: true,
      canContinue: unavailableReason === null,
      unavailableReason,
      estimatedContextTokens: Math.ceil(
        JSON.stringify(buildSessionContext(entries, entry.id).messages).length / 4,
      ),
    };
  };
  const common = {
    sessionId: manager.getSessionId(),
    activeEntryId: manager.getLeafId(),
    anchorEntryId: cursor.anchorId,
    tokenEstimate: "Approximate serialized context characters / 4, not provider token usage.",
  };
  if (input.view === "read") {
    const entry = entries.find((candidate) => candidate.id === input.entryId);
    if (!entry) throw new Error("Entry is outside the cursor snapshot.");
    const text = entryText(entry, input.includeToolResults);
    const content = text.slice(cursor.offset, cursor.offset + 8000);
    const path = manager.getBranch(entry.id);
    const beforeCount = input.before ?? 2;
    const before =
      beforeCount === 0
        ? []
        : path
            .slice(0, -1)
            .filter((item) => index.has(item.id))
            .slice(-beforeCount);
    const after: SessionEntry[] = [];
    let children = entries.filter((item) => item.parentId === entry.id);
    for (let i = 0; i < (input.after ?? 2) && children.length === 1; i++) {
      const child = children[0];
      if (!child) break;
      after.push(child);
      children = entries.filter((item) => item.parentId === child.id);
    }
    return {
      ...common,
      entryId: entry.id,
      type: entry.type,
      checkpoint: index.has(entry.id),
      content,
      before: before.map((item) => ({ entryId: item.id, preview: entryText(item).slice(0, 240) })),
      after: after.map((item) => ({ entryId: item.id, preview: entryText(item).slice(0, 240) })),
      children: children.slice(0, 50).map((item) => item.id),
      childrenTruncated: children.length > 50,
      nextCursor:
        cursor.offset + content.length < text.length
          ? nextCursor(cursor, cursor.offset + content.length)
          : null,
    };
  }
  const query = input.query?.toLocaleLowerCase();
  const matches = [...index.values()].filter((checkpoint) => {
    if (input.view === "ancestors") return ancestors.has(checkpoint.entry.id);
    if (input.view === "children") return checkpoint.parentCheckpointId === anchorCheckpoint;
    if (input.view !== "search") return true;
    const assistant = manager.getEntry(checkpoint.assistantId);
    const user = manager
      .getBranch(checkpoint.entry.id)
      .toReversed()
      .find((entry) => entry.type === "message" && entry.message.role === "user");
    const content = [
      manager.getLabel(checkpoint.entry.id) ?? "",
      user ? entryText(user) : "",
      assistant ? entryText(assistant, input.includeToolResults) : "",
      entryText(checkpoint.entry, input.includeToolResults),
    ].join("\n");
    return query !== undefined && content.toLocaleLowerCase().includes(query);
  });
  const limit = input.limit ?? 20;
  const page = matches.slice(cursor.offset, cursor.offset + limit);
  return {
    ...common,
    checkpoints: page.map(describe),
    total: matches.length,
    nextCursor:
      cursor.offset + page.length < matches.length
        ? nextCursor(cursor, cursor.offset + page.length)
        : null,
  };
}
