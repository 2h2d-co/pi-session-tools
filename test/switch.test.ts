import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type ExtensionFactory,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { NO_SOURCE } from "../src/switch.ts";
import { HANDOFF_TYPE, JOURNAL_TYPE, lastCheckpoint } from "../src/history.ts";
import { SYSTEM_INSTRUCTIONS, testRuntime } from "./support/runtime.ts";

type Runtime = Awaited<ReturnType<typeof testRuntime>>;

function handoffs(entries: readonly SessionEntry[]) {
  return entries.flatMap((entry) =>
    entry.type === "custom_message" && entry.customType === HANDOFF_TYPE ? [entry] : [],
  );
}

function phases(file: string): unknown[] {
  return SessionManager.open(file)
    .getEntries()
    .flatMap((entry) => {
      const data: unknown = entry.type === "custom" ? entry.data : undefined;
      return entry.type === "custom" &&
        entry.customType === JOURNAL_TYPE &&
        typeof data === "object" &&
        data !== null &&
        "phase" in data
        ? [data.phase]
        : [];
    });
}

function text(runtime: Runtime["runtime"]): string {
  return JSON.stringify(runtime.session.messages);
}

/** Plan in a source session, then hand off to a new session with a typed `/handoff new`. */
async function sourceThenNew({ runtime, faux }: Runtime) {
  faux.setResponses([fauxAssistantMessage("Approved plan: use SQLite.")]);
  await runtime.session.prompt("Plan");
  const checkpoint = lastCheckpoint(runtime.session.sessionManager);
  assert.ok(checkpoint);
  const sourceFile = runtime.session.sessionManager.getSessionFile();
  assert.ok(sourceFile);
  faux.setResponses([fauxAssistantMessage("Started the fresh session.")]);
  await runtime.session.prompt("/handoff new Start fresh");
  await runtime.session.waitForIdle();
  const newFile = runtime.session.sessionManager.getSessionFile();
  assert.ok(newFile && newFile !== sourceFile);
  return { checkpointId: checkpoint.entry.id, sourceFile, newFile };
}

test("a typed switch without a target returns to the source of the latest handoff, both ways", async () => {
  const setup = await testRuntime();
  const { runtime, faux, errors } = setup;
  try {
    const { checkpointId, sourceFile, newFile } = await sourceThenNew(setup);
    const newCheckpoint = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(newCheckpoint);
    faux.setResponses([
      (context) => {
        const seen = JSON.stringify(context.messages);
        assert.match(seen, /Approved plan: use SQLite/);
        assert.match(seen, /User-authored session handoff/);
        assert.match(seen, /Go back to the plan/);
        assert.doesNotMatch(seen, /Started the fresh session/);
        return fauxAssistantMessage("Back in the source session.");
      },
    ]);
    await runtime.session.prompt("/handoff switch Go back to the plan");
    await runtime.session.waitForIdle();
    assert.equal(runtime.session.sessionManager.getSessionFile(), sourceFile);
    assert.match(text(runtime), /Back in the source session/);
    const branch = runtime.session.sessionManager.getBranch();
    assert.ok(branch.some((entry) => entry.id === checkpointId));
    const delivered = handoffs(branch);
    assert.equal(delivered.length, 1);
    assert.match(JSON.stringify(delivered[0]?.details), new RegExp(JSON.stringify(newFile)));
    assert.deepEqual(phases(newFile).slice(-3), ["accepted", "applying", "replaced"]);

    // The source now names the new session as its handoff source, so switch goes back there.
    faux.setResponses([
      (context) => {
        const seen = JSON.stringify(context.messages);
        assert.match(seen, /Started the fresh session/);
        assert.doesNotMatch(seen, /Back in the source session/);
        return fauxAssistantMessage("Back in the new session.");
      },
    ]);
    await runtime.session.prompt("/handoff switch Return to the fresh work");
    await runtime.session.waitForIdle();
    assert.equal(runtime.session.sessionManager.getSessionFile(), newFile);
    assert.ok(
      runtime.session.sessionManager
        .getBranch()
        .some((entry) => entry.id === newCheckpoint.entry.id),
    );
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("a typed switch accepts an explicit session file and checkpoint", async () => {
  const setup = await testRuntime();
  const { runtime, faux, errors, cwd } = setup;
  try {
    faux.setResponses([fauxAssistantMessage("First answer")]);
    await runtime.session.prompt("First question");
    const first = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(first);
    faux.setResponses([fauxAssistantMessage("Second answer")]);
    await runtime.session.prompt("Second question");
    const sourceFile = runtime.session.sessionManager.getSessionFile();
    assert.ok(sourceFile);
    await runtime.newSession();
    faux.setResponses([fauxAssistantMessage("Other work")]);
    await runtime.session.prompt("Other work");
    faux.setResponses([
      (context) => {
        const seen = JSON.stringify(context.messages);
        assert.match(seen, /First answer/);
        assert.doesNotMatch(seen, /Second answer|Other work/);
        return fauxAssistantMessage("Continued from the first answer.");
      },
    ]);
    const relative = sourceFile.slice(cwd.length + 1);
    await runtime.session.prompt(
      `/handoff switch ${JSON.stringify(relative)} ${first.entry.id} Continue from here`,
    );
    await runtime.session.waitForIdle();
    assert.equal(runtime.session.sessionManager.getSessionFile(), sourceFile);
    assert.match(text(runtime), /Continued from the first answer/);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("without a handoff source, the session and checkpoint are chosen interactively", async () => {
  const titles: string[] = [];
  let checkpointId = "";
  const { runtime, faux, errors } = await testRuntime(undefined, "rpc", true, {
    select: async (title, options) => {
      titles.push(title);
      return title === "Session to switch to"
        ? options[0]
        : options.find((option) => option.startsWith(checkpointId));
    },
    editor: async (title) => {
      titles.push(title);
      return "Pick up the earlier plan";
    },
  });
  try {
    faux.setResponses([fauxAssistantMessage("Earlier plan")]);
    await runtime.session.prompt("Plan");
    const checkpoint = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(checkpoint);
    checkpointId = checkpoint.entry.id;
    const sourceFile = runtime.session.sessionManager.getSessionFile();
    await runtime.newSession();
    faux.setResponses([fauxAssistantMessage("Unrelated")]);
    await runtime.session.prompt("Unrelated work");
    faux.setResponses([fauxAssistantMessage("Resumed the earlier plan.")]);
    await runtime.session.prompt("/handoff switch");
    await runtime.session.waitForIdle();
    assert.deepEqual(titles, [
      "Session to switch to",
      "Checkpoint to switch to",
      "Handoff message for the next run",
    ]);
    assert.equal(runtime.session.sessionManager.getSessionFile(), sourceFile);
    assert.equal(handoffs(runtime.session.sessionManager.getBranch()).length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("an agent switch returns to the source checkpoint with current instructions", async () => {
  const setup = await testRuntime();
  const { runtime, faux, errors } = setup;
  try {
    const { checkpointId, sourceFile, newFile } = await sourceThenNew(setup);
    let prompt = "";
    const resume: FauxResponseFactory = (context) => {
      const seen = JSON.stringify(context.messages);
      assert.match(seen, /Agent-authored session handoff/);
      assert.match(seen, /The fresh session found the bug/);
      assert.match(seen, /Approved plan: use SQLite/);
      prompt = getCurrentSystemPrompt(context.messages);
      return fauxAssistantMessage("Continued in the source session.");
    };
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("session_handoff", {
          mode: "switch",
          handoff: { kind: "inline", text: "The fresh session found the bug." },
        }),
      ),
      resume,
    ]);
    await runtime.session.prompt("Report back to the source session");
    await runtime.session.waitForIdle();
    assert.equal(runtime.session.sessionManager.getSessionFile(), sourceFile);
    assert.ok(prompt.includes(SYSTEM_INSTRUCTIONS));
    const branch = runtime.session.sessionManager.getBranch();
    assert.ok(branch.some((entry) => entry.id === checkpointId));
    assert.equal(handoffs(branch).length, 1);
    assert.match(text(runtime), /Continued in the source session/);
    const accepted = SessionManager.open(newFile)
      .getEntries()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === JOURNAL_TYPE &&
          JSON.stringify(entry.data).includes('"accepted"'),
      );
    // The resolved destination is recorded, so the operation is inspectable later.
    assert.match(JSON.stringify(accepted), new RegExp(checkpointId));
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("switch rejects missing sources, the current session, other directories, and non-checkpoints", async () => {
  const { runtime, faux, errors, cwd } = await testRuntime();
  try {
    faux.setResponses([fauxAssistantMessage("Plan")]);
    await runtime.session.prompt("Plan");
    const manager = runtime.session.sessionManager;
    const checkpoint = lastCheckpoint(manager);
    const file = manager.getSessionFile();
    assert.ok(checkpoint && file);
    const user = manager.getBranch().find((entry) => entry.type === "message");
    assert.ok(user);
    const elsewhere = join(cwd, "elsewhere.jsonl");
    await writeFile(
      elsewhere,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "elsewhere",
        timestamp: new Date().toISOString(),
        cwd: join(cwd, "other-project"),
      })}\n`,
    );
    const notJsonl = join(cwd, "notes.txt");
    await writeFile(notJsonl, "Plain notes\n");
    await runtime.newSession();
    faux.setResponses([fauxAssistantMessage("Other")]);
    await runtime.session.prompt("Other");
    const otherFile = runtime.session.sessionManager.getSessionFile();
    const otherCheckpoint = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(otherFile && otherCheckpoint);
    const cases: [Record<string, string>, RegExp][] = [
      [{}, new RegExp(NO_SOURCE.replaceAll(".", "\\."))],
      [
        { targetSessionFile: otherFile, targetEntryId: otherCheckpoint.entry.id },
        /current session/,
      ],
      [{ targetSessionFile: elsewhere, targetEntryId: "x" }, /another working directory/],
      [{ targetSessionFile: notJsonl, targetEntryId: "x" }, /not a saved Pi session/],
      [{ targetSessionFile: join(cwd, "missing.jsonl"), targetEntryId: "x" }, /does not exist/],
      [{ targetSessionFile: file }, /together, or neither/],
      [{ targetSessionFile: file, targetEntryId: user.id }, /not a completed turn/],
    ];
    for (const [target, error] of cases) {
      const before = runtime.session.sessionManager.getEntries().length;
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("session_handoff", {
            mode: "switch",
            ...target,
            handoff: { kind: "inline", text: "Go back" },
          }),
        ),
        fauxAssistantMessage("Stayed"),
      ]);
      await runtime.session.prompt("Switch back");
      await runtime.session.waitForIdle();
      assert.equal(runtime.session.sessionManager.getSessionFile(), otherFile);
      const result = runtime.session.messages.findLast((message) => message.role === "toolResult");
      assert.ok(result?.role === "toolResult" && result.isError);
      assert.match(JSON.stringify(result.content), error);
      assert.ok(runtime.session.sessionManager.getEntries().length > before);
    }
    assert.equal(await readFile(notJsonl, "utf8"), "Plain notes\n");
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("extension cancellation of the session switch stops delivery", async () => {
  let cancel = false;
  const cancelling: ExtensionFactory = (pi) => {
    pi.on("session_before_switch", () => (cancel ? { cancel: true } : undefined));
  };
  const setup = await testRuntime(cancelling);
  const { runtime, faux, errors } = setup;
  try {
    const { sourceFile, newFile } = await sourceThenNew(setup);
    const sourceEntries = SessionManager.open(sourceFile).getEntries().length;
    cancel = true;
    await runtime.session.prompt("/handoff switch Go back");
    await runtime.session.waitForIdle();
    assert.equal(runtime.session.sessionManager.getSessionFile(), newFile);
    assert.deepEqual(phases(newFile).slice(-3), ["accepted", "applying", "failed"]);
    assert.equal(SessionManager.open(sourceFile).getEntries().length, sourceEntries);
    assert.equal(faux.state.callCount, 2);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});
