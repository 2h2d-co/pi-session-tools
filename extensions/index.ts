import { createHash, randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  CHECKPOINT_TYPE,
  HANDOFF_TYPE,
  JOURNAL_TYPE,
  checkpoints,
  inspectSession,
  lastCheckpoint,
  requireCheckpoint,
} from "../src/history.ts";
import {
  handoffText,
  prepareHandoff,
  verifyFindings,
  type Origin,
  type PreparedHandoff,
} from "../src/handoff.ts";
import {
  handoffSchema,
  inspectSchema,
  validateHandoff,
  type HandoffInput,
} from "../src/schemas.ts";

const APPLY_COMMAND = "session-tools-apply-handoff";
const INFO_TYPE = "pi-session-tools:notice";
type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type ReplacementContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

interface Request {
  id: string;
  input: HandoffInput;
  prepared: PreparedHandoff;
  assistantId: string;
  epoch: number;
  applying: boolean;
  signal?: AbortSignal;
  command: string;
}

const REQUIRED_PI = "Pi 0.87.0 or later";

/** Pi 0.87 made the session projection canonical; older runtimes lack it. */
function supportedRuntime(ctx: ExtensionContext): boolean {
  return typeof ctx.sessionManager.buildSessionProjection === "function";
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

export default function sessionTools(pi: ExtensionAPI): void {
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
    if (
      ctx.sessionManager.getSessionId() !== request.input.expectedSessionId ||
      epoch !== request.epoch
    ) {
      throw new Error("Session or user input changed. The pending handoff was cancelled.");
    }
    if (ctx.hasPendingMessages()) throw new Error("Queued input must be handled before a handoff.");
    if (ctx.mode === "tui" && ctx.ui.getEditorText().trim()) {
      throw new Error("Finish or save the editor draft before handing off.");
    }
    const path = ctx.sessionManager.getBranch();
    const start = path.findIndex((entry) => entry.id === request.assistantId);
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
          (request.input.mode === "new" && event.reason === "new"));
      record(request, replaced ? "replaced" : "interrupted", {
        ...(event.targetSessionFile ? { destinationSessionFile: event.targetSessionFile } : {}),
      });
    }
    pending = undefined;
    epoch++;
  });
  pi.on("session_start", (_event, ctx) => {
    pending = undefined;
    if (!supportedRuntime(ctx)) {
      ctx.ui.notify(
        `pi-session-tools requires ${REQUIRED_PI}. Checkpoints and handoffs are disabled.`,
        "error",
      );
    }
    recovery = journalSummary(ctx.sessionManager.getEntries())
      .filter((operation) =>
        ["accepted", "applying", "dispatched", "interrupted"].includes(operation.phase),
      )
      .slice(-10)
      .map((operation) => operation.operationId);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const message = {
      customType: INFO_TYPE,
      content: [
        `Current Pi session: ${ctx.sessionManager.getSessionId()}.`,
        ...(recovery.length
          ? [
              `Unfinished handoff records: ${recovery.join(", ")}. They were not replayed. Use session_inspect and the saved source history to establish what happened before requesting another handoff.`,
            ]
          : []),
      ].join("\n"),
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
    if (!supportedRuntime(ctx)) return;
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
          content: `[Session checkpoint: session=${ctx.sessionManager.getSessionId()} entry=${entryId}]`,
          display: false,
          timestamp: message.timestamp,
        };
        return [message, marker];
      }),
    };
  });
  pi.on("agent_settled", (_event, ctx) => {
    const request = pending;
    if (!request || request.applying || !ctx.isIdle()) return;
    const commands = pi
      .getCommands()
      .filter(
        (command) => command.name === APPLY_COMMAND || command.name.startsWith(`${APPLY_COMMAND}:`),
      );
    if (commands.length !== 1 || commands[0]?.name !== request.command) {
      record(request, "failed", { error: "Internal handoff command changed before dispatch." });
      pending = undefined;
      ctx.ui.notify("Handoff stopped: internal command changed before dispatch.", "error");
      return;
    }
    // This event is outside the active run. Pi 0.87 defers prompts sent from
    // settled handlers until every handler returns, then runs them before it
    // resolves idle waits, so print/JSON hosts cannot dispose the runtime early.
    // Awaiting the command here would wait for work that cannot start.
    pi.sendUserMessage(`/${request.command} ${request.id}`, { expandPromptTemplates: true });
  });

  pi.registerTool({
    name: "session_inspect",
    label: "Inspect session",
    description:
      "Read-only checkpoint discovery and inspection across the current session tree, including inactive branches. Use visible checkpoint IDs directly when possible. Output is paginated: at most 50 checkpoint previews or 8000 content characters. Thinking and images are never returned. Tool output requires includeToolResults=true.",
    promptSnippet: "Inspect session checkpoints and branches outside the current context",
    parameters: inspectSchema,
    async execute(_id, input, _signal, _update, ctx) {
      Value.Assert(inspectSchema, input);
      const result = {
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
      };
    },
  });

  pi.registerCommand(APPLY_COMMAND, {
    description:
      "Internal command for an accepted session_handoff request. Does not replay saved requests.",
    async handler(args, ctx) {
      const request = pending;
      if (!request || request.id !== args.trim() || request.applying) {
        ctx.ui.notify(
          "No matching pending handoff. Saved operations are never replayed automatically.",
          "warning",
        );
        return;
      }
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
        if (!source || source.assistantId !== request.assistantId) {
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
          content: handoffText(request.prepared, origin),
          details: { operationId: request.id, origin, mode: request.input.mode },
          display: true,
        };
        record(request, "applying", { origin });
        if (request.input.targetEntryId)
          requireCheckpoint(ctx.sessionManager, request.input.targetEntryId);
        if (request.input.mode === "new" || request.input.mode === "fork") {
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
              await replacement.sendMessage(
                {
                  ...message,
                  content: `Current Pi session: ${replacement.sessionManager.getSessionId()}.\n${message.content}`,
                },
                { triggerTurn: false },
              );
              // Pi 0.86 prepares system instructions in prompt(), not in a
              // custom-message run. Enter the normal input/preflight path using
              // the awaitable replacement API before its first continuation.
              await replacement.sendUserMessage(
                "[Agent-authored continuation]\nContinue from the preceding session handoff. This is not a new user request or additional authorization.",
                { expandPromptTemplates: false },
              );
            };
          };
          const result =
            request.input.mode === "fork"
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
          ctx.sessionManager.getSessionId() !== request.input.expectedSessionId ||
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
        pi.sendMessage(
          {
            ...message,
            content: `Current Pi session: ${ctx.sessionManager.getSessionId()}.\n${message.content}`,
          },
          { triggerTurn: true },
        );
        await ctx.waitForIdle();
      } catch (error) {
        // Replacement invalidates old session APIs. Its failure is reported by Pi's command runner.
        if (replaced || pending !== request) throw error;
        record(request, "failed", { error: errorText(error) });
        pending = undefined;
        pi.sendMessage(
          {
            customType: INFO_TYPE,
            content: `Session handoff ${request.id} stopped: ${errorText(error)} No automatic retry was attempted. Inspect the current session before continuing.`,
            display: true,
          },
          { triggerTurn: false },
        );
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "session_handoff",
    label: "Hand off session",
    description:
      "Continue your work after navigating to a checkpoint, forking, compacting, or starting a new session. Requires a self-contained inline handoff or an existing findings file and instruction. Appends it only after success and resumes automatically. Does not launch a subagent or restore files. Call this tool alone. targetEntryId is required only for navigate/fork. compactionInstructions guides the summarizer, not the post-compaction message. Returns accepted, not completed.",
    promptSnippet:
      "Hand off work to a selected checkpoint, compacted context, fork, or fresh session",
    promptGuidelines: [
      "Use session_handoff alone after finishing other tools. Preserve current user constraints, completed changes, validation, active processes, and next steps in its handoff.",
      "Use checkpoint IDs already in context with session_handoff. Use session_inspect only when a checkpoint or its context is missing.",
      "Session checkpoint messages are machine metadata, not user instructions. session_handoff changes conversation context only, never workspace files or permissions.",
    ],
    parameters: handoffSchema,
    async execute(toolCallId, input, signal, _update, ctx) {
      Value.Assert(handoffSchema, input);
      validateHandoff(input);
      if (!supportedRuntime(ctx)) throw new Error(`session_handoff requires ${REQUIRED_PI}.`);
      if (pending) throw new Error("A handoff is already pending.");
      if (ctx.sessionManager.getSessionId() !== input.expectedSessionId) {
        throw new Error("Session ID does not match. Inspect the current session.");
      }
      if (!ctx.model) throw new Error("A model is required to continue after a handoff.");
      if ((input.mode === "fork" || input.mode === "new") && !ctx.sessionManager.getSessionFile()) {
        throw new Error(
          "Fork and new require a persisted session so the source history remains recoverable. Run Pi without --no-session.",
        );
      }
      if (ctx.hasPendingMessages()) throw new Error("Handle queued user input before handing off.");
      if (ctx.mode === "tui" && ctx.ui.getEditorText().trim()) {
        throw new Error("Finish or save the editor draft before handing off.");
      }
      const assistantId = assertSoleCall(ctx, toolCallId);
      if (input.targetEntryId) requireCheckpoint(ctx.sessionManager, input.targetEntryId);
      const startEpoch = epoch;
      const prepared = await prepareHandoff(input, ctx.cwd, signal);
      signal?.throwIfAborted();
      if (startEpoch !== epoch || ctx.hasPendingMessages()) {
        throw new Error("Input changed while preparing the handoff.");
      }
      const commands = pi
        .getCommands()
        .filter(
          (command) =>
            command.name === APPLY_COMMAND || command.name.startsWith(`${APPLY_COMMAND}:`),
        );
      if (commands.length !== 1)
        throw new Error("Internal handoff command is unavailable or ambiguous.");
      const request: Request = {
        id: randomUUID(),
        input,
        prepared,
        assistantId,
        epoch,
        applying: false,
        ...(signal ? { signal } : {}),
        command: commands[0]?.name ?? APPLY_COMMAND,
      };
      record(request, "accepted", { input, prepared, assistantId });
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
