import { createHash, randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { requirePiVersion } from "../src/pi-version.ts";
import {
  CHECKPOINT_TYPE,
  HANDOFF_TYPE,
  JOURNAL_TYPE,
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
  handoffSchema,
  inspectOutputSchema,
  inspectSchema,
  validateHandoff,
  type HandoffInput,
  type InspectOutput,
} from "../src/schemas.ts";

const COMMAND = "session-handoff";
const MAX_TEXT = 16000;
const INFO_TYPE = "pi-session-tools:notice";
type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type ReplacementContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

interface Request {
  id: string;
  author: Author;
  input: HandoffInput;
  prepared: PreparedHandoff;
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

/** The command's invocation name. Pi suffixes duplicate names, such as `session-handoff:2`. */
function ownCommand(pi: ExtensionAPI): string | undefined {
  const commands = pi
    .getCommands()
    .filter((command) => command.name === COMMAND || command.name.startsWith(`${COMMAND}:`));
  return commands.length === 1 ? commands[0]?.name : undefined;
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
    if (!request || request.author !== "agent" || request.applying || !ctx.isIdle()) return;
    const command = ownCommand(pi);
    if (!command) {
      record(request, "failed", { error: "Handoff command is unavailable or ambiguous." });
      pending = undefined;
      ctx.ui.notify("Handoff stopped: /session-handoff is unavailable or ambiguous.", "error");
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
            // Pi prepares a custom-message run like a prompt, so the handoff
            // itself starts the continuation with current instructions and tools.
            await replacement.sendMessage(
              {
                ...message,
                content: `Current Pi session: ${replacement.sessionManager.getSessionId()}.\n${message.content}`,
              },
              { triggerTurn: true },
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
  }

  /** Build a user request from command arguments, asking for omitted parts when a UI exists. */
  async function userRequest(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<Request | undefined> {
    if (pending) throw new Error("A handoff is already pending.");
    if (!ctx.isIdle()) throw new Error("Wait for the agent to finish before handing off.");
    const manager = ctx.sessionManager;
    const parsed = parseHandoffCommand(args, (id) => manager.getEntry(id) !== undefined);
    let mode: Mode | undefined = parsed.mode;
    if (!mode) {
      if (!ctx.hasUI) throw new Error(USAGE);
      const labels = MODES.map((item) => `${item.mode}: ${item.description}`);
      const choice = await ctx.ui.select("Hand off this conversation", labels);
      mode = MODES[labels.indexOf(choice ?? "")]?.mode;
      if (!mode) return undefined;
    }
    let targetEntryId = parsed.targetEntryId;
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
    if ((mode === "fork" || mode === "new") && !manager.getSessionFile()) {
      throw new Error(
        "Fork and new require a persisted session so the source history remains recoverable. Run Pi without --no-session.",
      );
    }
    if (ctx.hasPendingMessages()) throw new Error("Handle queued user input before handing off.");
    if (ctx.mode === "tui" && ctx.ui.getEditorText().trim()) {
      throw new Error("Finish or save the editor draft before handing off.");
    }
    const sourceId = manager.getLeafId();
    if (!sourceId || !lastCheckpoint(manager)) {
      throw new Error("No completed turn to hand off from yet.");
    }
    if (targetEntryId) requireCheckpoint(manager, targetEntryId);
    const input: HandoffInput = {
      expectedSessionId: manager.getSessionId(),
      mode,
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
      sourceId,
      epoch,
      applying: false,
    };
  }

  pi.registerCommand(COMMAND, {
    description:
      "Start a new session, fork, return to a checkpoint, or compact, then continue with your message",
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
      "Continue your work after navigating to a checkpoint, forking, compacting, or starting a new session. Requires a self-contained inline handoff or an existing findings file and instruction. Appends it only after success and resumes automatically. Does not launch a subagent or restore files. Call this tool alone. targetEntryId is required only for navigate/fork. compactionInstructions guides the summarizer, not the post-compaction message. Returns accepted, not completed.",
    promptSnippet:
      "Hand off work to a selected checkpoint, compacted context, fork, or fresh session",
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
      if (!ownCommand(pi))
        throw new Error("The /session-handoff command is unavailable or ambiguous.");
      const request: Request = {
        id: randomUUID(),
        author: "agent",
        input,
        prepared,
        sourceId: assistantId,
        epoch,
        applying: false,
        ...(signal ? { signal } : {}),
      };
      record(request, "accepted", { input, prepared, assistantId, author: "agent" });
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
