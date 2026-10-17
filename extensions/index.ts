import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { SessionManager, truncateHead } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { requirePiVersion } from "../src/pi-version.ts";
import {
  CHECKPOINT_TYPE,
  HANDOFF_TYPE,
  JOURNAL_TYPE,
  NOTICE_TYPE,
  checkpoints,
  inspectSession,
  lastCheckpoint,
  recentCheckpoints,
  requireCheckpoint,
} from "../src/history.ts";
import { MODES, USAGE, parseHandoffCommand, type Mode } from "../src/command.ts";
import {
  handoffText,
  prepareHandoff,
  verifyFindings,
  type Author,
  type Origin,
  type PreparedHandoff,
} from "../src/handoff.ts";
import {
  NO_SOURCE,
  existingFile,
  handoffSource,
  openSession,
  switchTarget,
  type SwitchTarget,
} from "../src/switch.ts";
import {
  handoffSchema,
  inspectOutputSchema,
  inspectSchema,
  validateHandoff,
  type HandoffInput,
  type InspectOutput,
} from "../src/schemas.ts";

const COMMAND = "handoff";
const COMMAND_DESCRIPTION =
  "Start a new session, fork, return to a checkpoint, compact, or switch sessions, then continue with your message";
const MAX_TEXT = 16000;
type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type ReplacementContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

interface Request {
  id: string;
  author: Author;
  input: HandoffInput;
  prepared: PreparedHandoff;
  /** The session the request was made in. Applying it anywhere else is refused. */
  sessionId: string;
  /** Last entry when the request was made: the handoff call's assistant message, or the user's leaf. */
  sourceId: string;
  epoch: number;
  applying: boolean;
  signal?: AbortSignal;
}

function operationId(entry: SessionEntry): string | undefined {
  const data: unknown =
    entry.type === "custom"
      ? entry.data
      : entry.type === "custom_message"
        ? entry.details
        : undefined;
  if (typeof data === "object" && data !== null && "operationId" in data) {
    return typeof data.operationId === "string" ? data.operationId : undefined;
  }
  return undefined;
}

function journalSummary(entries: readonly SessionEntry[]) {
  const operations = new Map<string, { operationId: string; phase: string }>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== JOURNAL_TYPE) continue;
    const id = operationId(entry);
    const data: unknown = entry.data;
    if (
      id &&
      typeof data === "object" &&
      data !== null &&
      "phase" in data &&
      typeof data.phase === "string"
    ) {
      operations.set(id, { operationId: id, phase: data.phase });
    }
  }
  return [...operations.values()];
}

/** The switch destination a request names, once acceptance has filled in both fields. */
function requestedTarget(input: HandoffInput): SwitchTarget | undefined {
  return input.targetSessionFile && input.targetEntryId
    ? { sessionFile: input.targetSessionFile, entryId: input.targetEntryId }
    : undefined;
}

const PERSISTED_ONLY =
  "Fork, new, and switch require a persisted session so the source history remains recoverable. Run Pi without --no-session.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Session operation failed.";
}

function assertSoleCall(ctx: ExtensionContext, toolCallId: string): string {
  const entry = ctx.sessionManager
    .getBranch()
    .toReversed()
    .find((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
  if (entry?.type !== "message" || entry.message.role !== "assistant") {
    throw new Error("A handoff must be invoked by an assistant tool call.");
  }
  const calls = entry.message.content.filter((block) => block.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.id !== toolCallId || calls[0].name !== "session_handoff") {
    throw new Error("Call session_handoff alone, after every other tool has finished.");
  }
  return entry.id;
}

/**
 * The command's invocation name. When another extension also registers `handoff`, Pi names the
 * copies `handoff:1`, `handoff:2`, and so on in load order. The description identifies ours.
 */
function ownCommand(pi: ExtensionAPI): string | undefined {
  const commands = pi
    .getCommands()
    .filter(
      (command) =>
        (command.name === COMMAND || command.name.startsWith(`${COMMAND}:`)) &&
        command.description === COMMAND_DESCRIPTION,
    );
  return commands.length === 1 ? commands[0]?.name : undefined;
}

/** Ask for another saved session in this working directory, newest first. */
async function chooseSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const current = ctx.sessionManager.getSessionFile();
  const sessions = (await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()))
    .filter(
      (session) =>
        session.messageCount > 0 &&
        resolve(session.cwd) === resolve(ctx.cwd) &&
        (!current || resolve(session.path) !== resolve(current)),
    )
    .toSorted((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, 50);
  if (!sessions.length) throw new Error("No other saved session in this working directory.");
  const labels = sessions.map((session) => {
    const title = (session.name ?? session.firstMessage).replaceAll(/\s+/g, " ").trim();
    const time = session.modified.toISOString().slice(0, 16).replace("T", " ");
    return `${session.id.slice(0, 8)}  ${time}  ${title.slice(0, 80)}`;
  });
  const choice = await ctx.ui.select("Session to switch to", labels);
  return sessions[labels.indexOf(choice ?? "")]?.path;
}

export default function sessionTools(pi: ExtensionAPI): void {
  requirePiVersion("pi-session-tools");
  let pending: Request | undefined;
  let epoch = 0;
  let recovery: string[] = [];

  function record(request: Request, phase: string, details?: Record<string, unknown>): void {
    pi.appendEntry(JOURNAL_TYPE, {
      operationId: request.id,
      phase,
      mode: request.input.mode,
      ...details,
    });
  }

  function assertCurrent(request: Request, ctx: ExtensionContext): void {
    if (ctx.sessionManager.getSessionId() !== request.sessionId || epoch !== request.epoch) {
      throw new Error("Session or user input changed. The pending handoff was cancelled.");
    }
    if (ctx.hasPendingMessages()) throw new Error("Queued input must be handled before a handoff.");
    if (ctx.mode === "tui" && ctx.ui.getEditorText().trim()) {
      throw new Error("Finish or save the editor draft before handing off.");
    }
    const path = ctx.sessionManager.getBranch();
    const start = path.findIndex((entry) => entry.id === request.sourceId);
    if (start < 0) throw new Error("Source branch changed. The pending handoff was cancelled.");
    const later = path.slice(start + 1);
    if (
      later.some(
        (entry) =>
          entry.type === "message" &&
          (entry.message.role === "user" || entry.message.role === "assistant"),
      )
    ) {
      throw new Error("Conversation advanced after the request. Prepare a new handoff.");
    }
  }

  pi.on("input", () => {
    epoch++;
  });
  pi.on("session_tree", (event) => {
    if (
      !pending?.applying ||
      pending.input.mode !== "navigate" ||
      pending.input.targetEntryId !== event.newLeafId
    )
      epoch++;
  });
  pi.on("session_shutdown", (event) => {
    const request = pending;
    if (request) {
      const replaced =
        request.applying &&
        ((request.input.mode === "fork" && event.reason === "fork") ||
          (request.input.mode === "new" && event.reason === "new") ||
          (request.input.mode === "switch" && event.reason === "resume"));
      record(request, replaced ? "replaced" : "interrupted", {
        ...(event.targetSessionFile ? { destinationSessionFile: event.targetSessionFile } : {}),
      });
    }
    pending = undefined;
    epoch++;
  });
  pi.on("session_start", (_event, ctx) => {
    pending = undefined;
    recovery = journalSummary(ctx.sessionManager.getEntries())
      .filter((operation) =>
        ["accepted", "applying", "dispatched", "interrupted"].includes(operation.phase),
      )
      .slice(-10)
      .map((operation) => operation.operationId);
  });
  pi.on("before_agent_start", () => {
    if (!recovery.length) return;
    const message = {
      customType: NOTICE_TYPE,
      content: `Unfinished handoff records: ${recovery.join(", ")}. They were not replayed. Use session_inspect and the saved source history to establish what happened before requesting another handoff.`,
      display: false,
    };
    recovery = [];
    return { message };
  });
  pi.on("turn_end", (event, ctx) => {
    const checkpoint = lastCheckpoint(ctx.sessionManager);
    const lastResult = event.toolResults.at(-1);
    if (!checkpoint) return;
    const { message } = checkpoint.entry;
    const matches = lastResult
      ? message.role === "toolResult" && message.toolCallId === lastResult.toolCallId
      : message === event.message;
    if (!matches) return;
    pi.appendEntry(CHECKPOINT_TYPE, { entryId: checkpoint.entry.id });
    const delivered = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom_message" && entry.customType === HANDOFF_TYPE)
      .map(operationId)
      .filter((id) => id !== undefined);
    const journals = journalSummary(ctx.sessionManager.getEntries());
    for (const id of delivered) {
      if (
        journals.some(
          (operation) => operation.operationId === id && operation.phase === "delivered",
        )
      )
        continue;
      pi.appendEntry(JOURNAL_TYPE, { operationId: id, phase: "delivered" });
    }
  });
  pi.on("context_with_system", (event, ctx) => {
    // Keep markers out of the persisted transcript: Pi print mode expects its
    // last actual message to be the assistant response. Project markers only at
    // the provider boundary, where they neither trigger turns nor hide that
    // response. The full-transcript event returns messages verbatim, so
    // mid-conversation system messages stay in place; a changed `context`
    // result would fold them into one leading message on every request.
    const index = checkpoints(ctx.sessionManager.getEntries());
    const ids = new Map<string, string[]>();
    for (const entry of ctx.sessionManager.buildSessionProjection().entries) {
      if (entry.sourceEntry.type !== "message" || !index.has(entry.sourceEntry.id)) continue;
      // Hash the projected message so a content edit still matches its entry.
      for (const message of entry.messages) {
        const key = createHash("sha256").update(JSON.stringify(message)).digest("hex");
        const matches = ids.get(key) ?? [];
        matches.push(entry.sourceEntry.id);
        ids.set(key, matches);
      }
    }
    return {
      messages: event.messages.flatMap((message) => {
        const key = createHash("sha256").update(JSON.stringify(message)).digest("hex");
        const entryId = ids.get(key)?.shift();
        if (!entryId) return [message];
        const marker: (typeof event.messages)[number] = {
          role: "custom",
          customType: CHECKPOINT_TYPE,
          content: `[Session checkpoint: entry=${entryId}]`,
          display: false,
          timestamp: message.timestamp,
        };
        return [message, marker];
      }),
    };
  });
  pi.on("agent_settled", (_event, ctx) => {
    const request = pending;
    if (!request || request.author !== "agent" || request.applying || !ctx.isIdle()) return;
    const command = ownCommand(pi);
    if (!command) {
      record(request, "failed", { error: "Handoff command is unavailable or ambiguous." });
      pending = undefined;
      ctx.ui.notify("Handoff stopped: /handoff is unavailable or ambiguous.", "error");
      return;
    }
    // This event is outside the active run. Pi defers prompts sent from
    // settled handlers until every handler returns, then runs them before it
    // resolves idle waits, so print/JSON hosts cannot dispose the runtime early.
    // Awaiting the command here would wait for work that cannot start.
    pi.sendUserMessage(`/${command} apply ${request.id}`, { expandPromptTemplates: true });
  });

  pi.registerTool({
    name: "session_inspect",
    label: "Inspect session",
    description:
      "Read-only checkpoint discovery and inspection across the current session tree, including inactive branches. Use visible checkpoint IDs directly when possible. Output is paginated: at most 50 checkpoint previews or 8000 content characters. Thinking and images are never returned. Tool output requires includeToolResults=true.",
    promptSnippet: "Inspect session checkpoints and branches outside the current context",
    parameters: inspectSchema,
    outputSchema: inspectOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, input, _signal, _update, ctx) {
      Value.Assert(inspectSchema, input);
      const result: InspectOutput = {
        history: inspectSession(ctx.sessionManager, input),
        operations: journalSummary(ctx.sessionManager.getEntries()).slice(-10),
      };
      const output = truncateHead(JSON.stringify(result), { maxBytes: 48000, maxLines: 2000 });
      return {
        content: [
          {
            type: "text",
            text:
              output.content +
              (output.truncated
                ? "\n[Output truncated. Reduce limit, before, or after and repeat the query.]"
                : ""),
          },
        ],
        details: {},
        // Programmatic callers get the complete page; only the model-facing text is truncated.
        structuredContent: result,
      };
    },
  });

  async function apply(request: Request, ctx: ExtensionCommandContext): Promise<void> {
    request.applying = true;
    let replaced = false;
    try {
      await ctx.waitForIdle();
      request.signal?.throwIfAborted();
      assertCurrent(request, ctx);
      await verifyFindings(request.prepared);
      assertCurrent(request, ctx);
      if (!ctx.isIdle()) throw new Error("The agent is no longer idle.");
      const source = lastCheckpoint(ctx.sessionManager);
      if (!source || (request.author === "agent" && source.assistantId !== request.sourceId)) {
        throw new Error("The handoff tool batch did not finish at the expected checkpoint.");
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      const origin: Origin = {
        sessionId: ctx.sessionManager.getSessionId(),
        entryId: source.entry.id,
        ...(sessionFile ? { sessionFile } : {}),
      };
      const message = {
        customType: HANDOFF_TYPE,
        content: handoffText(request.prepared, origin, request.author),
        details: {
          operationId: request.id,
          origin,
          mode: request.input.mode,
          author: request.author,
        },
        display: true,
      };
      record(request, "applying", { origin });
      // Check the destination again: either session may have changed since acceptance.
      const target =
        request.input.mode === "switch"
          ? switchTarget(ctx.sessionManager, ctx.cwd, requestedTarget(request.input))
          : undefined;
      if (request.input.targetEntryId && !target)
        requireCheckpoint(ctx.sessionManager, request.input.targetEntryId);
      if (
        request.input.mode === "new" ||
        request.input.mode === "fork" ||
        request.input.mode === "switch"
      ) {
        let resume: (() => Promise<void>) | undefined;
        const withSession = async (replacement: ReplacementContext) => {
          replaced = true;
          const leaf = replacement.sessionManager.getLeafId();
          resume = async () => {
            await verifyFindings(request.prepared);
            if (
              !replacement.isIdle() ||
              replacement.hasPendingMessages() ||
              replacement.sessionManager.getLeafId() !== leaf ||
              (replacement.mode === "tui" && replacement.ui.getEditorText().trim())
            ) {
              throw new Error("Replacement session received input before handoff delivery.");
            }
            if (target) {
              requireCheckpoint(replacement.sessionManager, target.entryId);
              const moved = await replacement.navigateTree(target.entryId, { summarize: false });
              if (moved.cancelled) throw new Error("Navigation was cancelled.");
              if (replacement.sessionManager.getLeafId() !== target.entryId) {
                throw new Error(
                  "Another extension changed the destination before handoff delivery.",
                );
              }
            }
            // Pi prepares a custom-message run like a prompt, so the handoff
            // itself starts the continuation with current instructions and tools.
            await replacement.sendMessage(message, { triggerTurn: true });
          };
        };
        const result = target
          ? await ctx.switchSession(target.sessionFile, { withSession })
          : request.input.mode === "fork"
            ? await ctx.fork(request.input.targetEntryId ?? "", { position: "at", withSession })
            : await ctx.newSession({
                ...(sessionFile ? { parentSession: sessionFile } : {}),
                withSession,
              });
        if (result.cancelled) throw new Error("Session replacement was cancelled.");
        // Let native TUI actions finish clearing the old editor before the
        // continuation starts. Only the fresh replacement context is used.
        if (resume) await resume();
        return;
      }
      if (request.input.mode === "navigate") {
        const result = await ctx.navigateTree(request.input.targetEntryId ?? "", {
          summarize: false,
        });
        if (result.cancelled) throw new Error("Navigation was cancelled.");
        if (ctx.sessionManager.getLeafId() !== request.input.targetEntryId) {
          throw new Error("Another extension changed the destination before handoff delivery.");
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          ctx.compact({
            ...(request.input.compactionInstructions
              ? { customInstructions: request.input.compactionInstructions }
              : {}),
            onComplete: () => {
              resolve();
            },
            onError: reject,
          });
        });
      }
      if (
        ctx.sessionManager.getSessionId() !== request.sessionId ||
        epoch !== request.epoch ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages()
      ) {
        throw new Error(
          "Input or session state changed after the operation. Handoff was not delivered.",
        );
      }
      await verifyFindings(request.prepared);
      if (!ctx.isIdle() || epoch !== request.epoch) {
        throw new Error("Input arrived before handoff delivery.");
      }
      record(request, "dispatched");
      pending = undefined;
      pi.sendMessage(message, { triggerTurn: true });
      await ctx.waitForIdle();
    } catch (error) {
      // Replacement invalidates old session APIs. Its failure is reported by Pi's command runner.
      if (replaced || pending !== request) throw error;
      record(request, "failed", { error: errorText(error) });
      pending = undefined;
      pi.sendMessage(
        {
          customType: NOTICE_TYPE,
          content: `Session handoff ${request.id} stopped: ${errorText(error)} No automatic retry was attempted. Inspect the current session before continuing.`,
          display: true,
        },
        { triggerTurn: false },
      );
      ctx.ui.notify(errorText(error), "error");
    }
  }

  /** Build a user request from command arguments, asking for omitted parts when a UI exists. */
  async function userRequest(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<Request | undefined> {
    if (pending) throw new Error("A handoff is already pending.");
    if (!ctx.isIdle()) throw new Error("Wait for the agent to finish before handing off.");
    const manager = ctx.sessionManager;
    const currentFile = manager.getSessionFile();
    const parsed = parseHandoffCommand(args, {
      isEntry(id, sessionFile) {
        if (!sessionFile) return manager.getEntry(id) !== undefined;
        try {
          return openSession(sessionFile, ctx.cwd, currentFile).manager.getEntry(id) !== undefined;
        } catch (error) {
          if (error instanceof Error) return false;
          throw error;
        }
      },
      isFile(path) {
        try {
          return existingFile(path, ctx.cwd) !== undefined;
        } catch (error) {
          if (error instanceof Error) return false;
          throw error;
        }
      },
    });
    let mode: Mode | undefined = parsed.mode;
    if (!mode) {
      if (!ctx.hasUI) throw new Error(USAGE);
      const labels = MODES.map((item) => `${item.mode}: ${item.description}`);
      const choice = await ctx.ui.select("Hand off this conversation", labels);
      mode = MODES[labels.indexOf(choice ?? "")]?.mode;
      if (!mode) return undefined;
    }
    if (mode !== "navigate" && mode !== "compact" && !currentFile) throw new Error(PERSISTED_ONLY);
    let targetEntryId = parsed.targetEntryId;
    let targetSessionFile = parsed.targetSessionFile;
    if (mode === "switch") {
      // Without a named session, return to where the latest handoff came from.
      const source = targetSessionFile ? undefined : handoffSource(manager);
      if (source) {
        targetSessionFile = source.sessionFile;
        targetEntryId = source.entryId;
      }
      if (!targetSessionFile) {
        if (!ctx.hasUI) throw new Error(NO_SOURCE);
        targetSessionFile = await chooseSession(ctx);
        if (!targetSessionFile) return undefined;
      }
      if (!targetEntryId) {
        if (!ctx.hasUI) throw new Error(USAGE);
        const options = recentCheckpoints(
          openSession(targetSessionFile, ctx.cwd, currentFile).manager,
          50,
        );
        if (!options.length) throw new Error("That session has no completed turn to return to.");
        const labels = options.map((item) => `${item.entryId}  ${item.preview}`);
        const choice = await ctx.ui.select("Checkpoint to switch to", labels);
        targetEntryId = options[labels.indexOf(choice ?? "")]?.entryId;
        if (!targetEntryId) return undefined;
      }
    }
    if (!targetEntryId && (mode === "fork" || mode === "navigate")) {
      if (!ctx.hasUI) throw new Error(USAGE);
      const options = recentCheckpoints(manager, 50);
      if (!options.length) throw new Error("No completed turn to hand off to yet.");
      const labels = options.map((item) => `${item.entryId}  ${item.preview}`);
      const choice = await ctx.ui.select(
        mode === "fork" ? "Checkpoint to fork from" : "Checkpoint to return to",
        labels,
      );
      targetEntryId = options[labels.indexOf(choice ?? "")]?.entryId;
      if (!targetEntryId) return undefined;
    }
    let text = parsed.text;
    if (!text) {
      if (!ctx.hasUI) throw new Error(USAGE);
      text = (await ctx.ui.editor("Handoff message for the next run"))?.trim();
      if (!text) return undefined;
    }
    if (text.length > MAX_TEXT) {
      throw new Error(`The handoff message exceeds ${MAX_TEXT} characters.`);
    }
    if (pending || !ctx.isIdle()) {
      throw new Error("The agent started while the handoff was being prepared.");
    }
    if (!ctx.model) throw new Error("A model is required to continue after a handoff.");
    if (ctx.hasPendingMessages()) throw new Error("Handle queued user input before handing off.");
    if (ctx.mode === "tui" && ctx.ui.getEditorText().trim()) {
      throw new Error("Finish or save the editor draft before handing off.");
    }
    const sourceId = manager.getLeafId();
    if (!sourceId || !lastCheckpoint(manager)) {
      throw new Error("No completed turn to hand off from yet.");
    }
    if (mode === "switch") {
      const target = switchTarget(
        manager,
        ctx.cwd,
        targetSessionFile && targetEntryId
          ? { sessionFile: targetSessionFile, entryId: targetEntryId }
          : undefined,
      );
      targetSessionFile = target.sessionFile;
      targetEntryId = target.entryId;
    } else if (targetEntryId) {
      requireCheckpoint(manager, targetEntryId);
    }
    const input: HandoffInput = {
      mode,
      ...(targetSessionFile ? { targetSessionFile } : {}),
      ...(targetEntryId ? { targetEntryId } : {}),
      handoff: { kind: "inline", text },
    };
    Value.Assert(handoffSchema, input);
    validateHandoff(input);
    return {
      id: randomUUID(),
      author: "user",
      input,
      prepared: await prepareHandoff(input, ctx.cwd),
      sessionId: manager.getSessionId(),
      sourceId,
      epoch,
      applying: false,
    };
  }

  pi.registerCommand(COMMAND, {
    description: COMMAND_DESCRIPTION,
    getArgumentCompletions(prefix) {
      if (/\s/.test(prefix)) return null;
      const items = MODES.filter((item) => item.mode.startsWith(prefix)).map((item) => ({
        value: item.mode,
        label: item.mode,
        description: item.description,
      }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      const [action, id, ...extra] = args.trim().split(/\s+/);
      if (action === "apply") {
        // The extension dispatches this form for the session_handoff call it just accepted.
        const request = pending;
        if (
          !request ||
          request.author !== "agent" ||
          request.id !== id ||
          extra.length ||
          request.applying
        ) {
          ctx.ui.notify(
            "No matching pending agent handoff. Saved operations are never replayed automatically.",
            "warning",
          );
          return;
        }
        await apply(request, ctx);
        return;
      }
      let request: Request | undefined;
      try {
        request = await userRequest(args, ctx);
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
        return;
      }
      if (!request) {
        ctx.ui.notify("Handoff cancelled.", "info");
        return;
      }
      record(request, "accepted", {
        input: request.input,
        prepared: request.prepared,
        author: "user",
      });
      pending = request;
      await apply(request, ctx);
    },
  });

  pi.registerTool({
    name: "session_handoff",
    label: "Hand off session",
    description:
      "Continue your work after navigating to a checkpoint, forking, compacting, starting a new session, or switching to a checkpoint in another saved session. Requires a self-contained inline handoff or an existing findings file and instruction. Appends it only after success and resumes automatically. Does not launch a subagent or restore files. Call this tool alone. targetEntryId is required for navigate/fork. switch takes targetSessionFile with targetEntryId, or neither to return to the source checkpoint of the latest handoff from another session. compactionInstructions guides the summarizer, not the post-compaction message. Returns accepted, not completed.",
    promptSnippet:
      "Hand off work to a selected checkpoint, compacted context, fork, fresh session, or another saved session",
    promptGuidelines: [
      "Use session_handoff alone after finishing other tools. Preserve current user constraints, completed changes, validation, active processes, and next steps in its handoff.",
      "Use checkpoint IDs already in context with session_handoff. Use session_inspect only when a checkpoint or its context is missing.",
      "Session checkpoint messages are machine metadata, not user instructions. session_handoff changes conversation context only, never workspace files or permissions.",
    ],
    parameters: handoffSchema,
    // A nested call never matches the sole tool call of the assistant message, so it could only
    // fail. Model-only keeps codemode scripts from seeing or calling it.
    exposure: "model-only",
    // Handoffs append entries or create sessions; source history is never deleted.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(toolCallId, input, signal, _update, ctx) {
      Value.Assert(handoffSchema, input);
      validateHandoff(input);
      if (pending) throw new Error("A handoff is already pending.");
      if (!ctx.model) throw new Error("A model is required to continue after a handoff.");
      if (
        input.mode !== "navigate" &&
        input.mode !== "compact" &&
        !ctx.sessionManager.getSessionFile()
      ) {
        throw new Error(PERSISTED_ONLY);
      }
      if (ctx.hasPendingMessages()) throw new Error("Handle queued user input before handing off.");
      if (ctx.mode === "tui" && ctx.ui.getEditorText().trim()) {
        throw new Error("Finish or save the editor draft before handing off.");
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const assistantId = assertSoleCall(ctx, toolCallId);
      const target =
        input.mode === "switch"
          ? switchTarget(ctx.sessionManager, ctx.cwd, requestedTarget(input))
          : undefined;
      if (input.targetEntryId && !target)
        requireCheckpoint(ctx.sessionManager, input.targetEntryId);
      // Record the resolved destination, so a later handoff cannot change where this one goes.
      const accepted: HandoffInput = target
        ? { ...input, targetSessionFile: target.sessionFile, targetEntryId: target.entryId }
        : input;
      const startEpoch = epoch;
      const prepared = await prepareHandoff(accepted, ctx.cwd, signal);
      signal?.throwIfAborted();
      if (
        startEpoch !== epoch ||
        ctx.hasPendingMessages() ||
        ctx.sessionManager.getSessionId() !== sessionId
      ) {
        throw new Error("Input or session changed while preparing the handoff.");
      }
      if (!ownCommand(pi)) throw new Error("The /handoff command is unavailable or ambiguous.");
      const request: Request = {
        id: randomUUID(),
        author: "agent",
        input: accepted,
        prepared,
        sessionId,
        sourceId: assistantId,
        epoch,
        applying: false,
        ...(signal ? { signal } : {}),
      };
      record(request, "accepted", { input: accepted, prepared, assistantId, author: "agent" });
      pending = request;
      // agent_settled dispatches the command. Never await it from this tool.
      return {
        content: [
          {
            type: "text",
            text: `Handoff accepted: ${request.id}. Execution continues only after the current tool batch finishes.`,
          },
        ],
        details: { operationId: request.id, phase: "accepted" },
        terminate: true,
      };
    },
  });
}
