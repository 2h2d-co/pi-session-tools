import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { USAGE, parseHandoffCommand } from "../src/command.ts";
import { HANDOFF_TYPE, JOURNAL_TYPE, lastCheckpoint } from "../src/history.ts";
import { testRuntime } from "./runtime.ts";

function handoffs(entries: readonly SessionEntry[]) {
  return entries.filter(
    (entry) => entry.type === "custom_message" && entry.customType === HANDOFF_TYPE,
  );
}

function phases(entries: readonly SessionEntry[]) {
  return entries.flatMap((entry) => {
    const data: unknown = entry.type === "custom" ? entry.data : undefined;
    return entry.type === "custom" &&
      entry.customType === JOURNAL_TYPE &&
      typeof data === "object" &&
      data !== null &&
      "phase" in data
      ? [data]
      : [];
  });
}

test("command arguments name a mode, an existing checkpoint, and a message", () => {
  const known = (id: string) => id === "abcd1234";
  assert.deepEqual(parseHandoffCommand("  ", known), {});
  assert.deepEqual(parseHandoffCommand("new Keep going\nwith tests", known), {
    mode: "new",
    text: "Keep going\nwith tests",
  });
  assert.deepEqual(parseHandoffCommand("compact", known), { mode: "compact" });
  assert.deepEqual(parseHandoffCommand("fork abcd1234 Try plan B", known), {
    mode: "fork",
    targetEntryId: "abcd1234",
    text: "Try plan B",
  });
  assert.deepEqual(parseHandoffCommand("navigate abcd1234", known), {
    mode: "navigate",
    targetEntryId: "abcd1234",
  });
  // A first word that is not an entry starts the message; the checkpoint is chosen later.
  assert.deepEqual(parseHandoffCommand("fork Try plan B", known), {
    mode: "fork",
    text: "Try plan B",
  });
  // Only targeted modes take a checkpoint.
  assert.deepEqual(parseHandoffCommand("new abcd1234 text", known), {
    mode: "new",
    text: "abcd1234 text",
  });
  assert.throws(() => parseHandoffCommand("restart now", known), { message: USAGE });
});

test("the command completes mode names but not the extension's apply form", async () => {
  const { runtime } = await testRuntime();
  try {
    const command = runtime.session.extensionRunner.getCommand("handoff");
    assert.ok(command?.getArgumentCompletions);
    const values = async (prefix: string) =>
      ((await command.getArgumentCompletions?.(prefix)) ?? []).map((item) => item.value);
    assert.deepEqual(await values(""), ["new", "fork", "navigate", "compact"]);
    assert.deepEqual(await values("f"), ["fork"]);
    assert.deepEqual(await values("a"), []);
    assert.deepEqual(await values("fork "), []);
  } finally {
    await runtime.dispose();
  }
});

for (const mode of ["new", "fork", "navigate", "compact"] as const) {
  test(`a typed ${mode} handoff delivers the user's message and resumes`, async () => {
    const { runtime, faux, errors } = await testRuntime();
    try {
      faux.setResponses([fauxAssistantMessage("Approved plan. ".repeat(200))]);
      await runtime.session.prompt("Plan the work");
      const checkpoint = lastCheckpoint(runtime.session.sessionManager);
      assert.ok(checkpoint);
      const source = runtime.session.sessionManager;
      const resume: FauxResponseFactory = (context) => {
        const text = JSON.stringify(context.messages);
        if (mode === "compact" && !text.includes("[User-authored session handoff]")) {
          faux.appendResponses([resume]);
          return fauxAssistantMessage("Compacted plan.");
        }
        assert.match(text, /User-authored session handoff/);
        assert.match(text, /Implement plan B with tests/);
        assert.doesNotMatch(text, /does not grant new permission/);
        return fauxAssistantMessage("Continued from the user's handoff");
      };
      faux.setResponses([resume]);
      const target = mode === "fork" || mode === "navigate" ? ` ${checkpoint.entry.id}` : "";
      await runtime.session.prompt(`/handoff ${mode}${target} Implement plan B with tests`);
      await runtime.session.waitForIdle();
      assert.match(
        JSON.stringify(runtime.session.messages.at(-1)),
        /Continued from the user's handoff/,
      );
      const delivered = handoffs(runtime.session.sessionManager.getEntries());
      assert.equal(delivered.length, 1);
      const details: unknown = delivered[0]?.type === "custom_message" && delivered[0].details;
      assert.ok(typeof details === "object" && details !== null && "author" in details);
      assert.equal(details.author, "user");
      if (mode === "new" || mode === "fork") {
        assert.notEqual(runtime.session.sessionId, source.getSessionId());
      } else {
        assert.equal(runtime.session.sessionId, source.getSessionId());
      }
      const sourcePhases = phases(source.getEntries()).map((data) =>
        "phase" in data ? data.phase : undefined,
      );
      assert.deepEqual(
        sourcePhases,
        mode === "new" || mode === "fork"
          ? ["accepted", "applying", "replaced"]
          : ["accepted", "applying", "dispatched", "delivered"],
      );
      assert.ok(
        phases(source.getEntries()).some((data) => "author" in data && data.author === "user"),
      );
      assert.deepEqual(errors, []);
    } finally {
      await runtime.dispose();
    }
  });
}

test("omitted command parts are chosen interactively", async () => {
  const titles: string[] = [];
  let checkpointId = "";
  const { runtime, faux, errors } = await testRuntime(undefined, "rpc", true, {
    select: async (title, options) => {
      titles.push(title);
      return title === "Hand off this conversation"
        ? options.find((option) => option.startsWith("fork:"))
        : options.find((option) => option.startsWith(checkpointId));
    },
    editor: async (title) => {
      titles.push(title);
      return "  Take the second approach  ";
    },
  });
  try {
    faux.setResponses([fauxAssistantMessage("First approach")]);
    await runtime.session.prompt("Plan");
    const checkpoint = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(checkpoint);
    checkpointId = checkpoint.entry.id;
    faux.setResponses([fauxAssistantMessage("Second response")]);
    await runtime.session.prompt("Continue");
    const sourceId = runtime.session.sessionId;
    faux.setResponses([
      (context) => {
        assert.match(JSON.stringify(context.messages), /Take the second approach/);
        assert.doesNotMatch(JSON.stringify(context.messages), /Second response/);
        return fauxAssistantMessage("Forked");
      },
    ]);
    await runtime.session.prompt("/handoff");
    await runtime.session.waitForIdle();
    assert.deepEqual(titles, [
      "Hand off this conversation",
      "Checkpoint to fork from",
      "Handoff message for the next run",
    ]);
    assert.notEqual(runtime.session.sessionId, sourceId);
    assert.equal(handoffs(runtime.session.sessionManager.getBranch()).length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("a cancelled choice or a missing message without a UI changes nothing", async () => {
  const notices: string[] = [];
  const { runtime, faux, errors } = await testRuntime(undefined, "rpc", true, {
    select: async () => undefined,
    notify: (message) => {
      notices.push(message);
    },
  });
  try {
    faux.setResponses([fauxAssistantMessage("Plan")]);
    await runtime.session.prompt("Plan");
    const entries = runtime.session.sessionManager.getEntries().length;
    await runtime.session.prompt("/handoff");
    await runtime.session.prompt("/handoff restart");
    await runtime.session.prompt("/handoff apply not-pending");
    assert.deepEqual(notices, [
      "Handoff cancelled.",
      USAGE,
      "No matching pending agent handoff. Saved operations are never replayed automatically.",
    ]);
    assert.equal(runtime.session.sessionManager.getEntries().length, entries);
    assert.equal(faux.state.callCount, 1);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }

  const print = await testRuntime();
  try {
    print.faux.setResponses([fauxAssistantMessage("Plan")]);
    await print.runtime.session.prompt("Plan");
    const entries = print.runtime.session.sessionManager.getEntries().length;
    await print.runtime.session.prompt("/handoff new");
    assert.equal(print.runtime.session.sessionManager.getEntries().length, entries);
    assert.equal(print.faux.state.callCount, 1);
  } finally {
    await print.runtime.dispose();
  }
});

test("a typed handoff needs a completed turn and a persisted session for fork and new", async () => {
  const notices: string[] = [];
  const { runtime, faux } = await testRuntime(undefined, "rpc", false, {
    notify: (message) => {
      notices.push(message);
    },
  });
  try {
    await runtime.session.prompt("/handoff compact Continue");
    faux.setResponses([fauxAssistantMessage("Plan")]);
    await runtime.session.prompt("Plan");
    await runtime.session.prompt("/handoff new Continue");
    assert.deepEqual(notices, [
      "No completed turn to hand off from yet.",
      "Fork and new require a persisted session so the source history remains recoverable. Run Pi without --no-session.",
    ]);
    assert.equal(handoffs(runtime.session.sessionManager.getEntries()).length, 0);
  } finally {
    await runtime.dispose();
  }
});

test("agent and typed handoffs find this extension's command when another extension also registers /handoff", async () => {
  let otherCalls = 0;
  const { runtime, faux, errors } = await testRuntime((pi) => {
    pi.registerCommand("handoff", {
      description: "Another extension's handoff",
      handler: async () => {
        otherCalls++;
      },
    });
  });
  try {
    const names = runtime.session.extensionRunner
      .getRegisteredCommands()
      .filter((command) => command.name === "handoff")
      .map((command) => command.invocationName);
    assert.equal(names.length, 2);
    const ours = runtime.session.extensionRunner
      .getRegisteredCommands()
      .find((command) => command.name === "handoff" && command.description?.startsWith("Start"));
    assert.ok(ours);
    assert.match(ours.invocationName, /^handoff:\d$/);
    faux.setResponses([fauxAssistantMessage("Plan")]);
    await runtime.session.prompt("Plan");
    const checkpoint = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(checkpoint);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("session_handoff", {
          expectedSessionId: runtime.session.sessionId,
          mode: "navigate",
          targetEntryId: checkpoint.entry.id,
          handoff: { kind: "inline", text: "Agent continuation" },
        }),
      ),
      fauxAssistantMessage("Continued after the agent handoff"),
    ]);
    await runtime.session.prompt("Plan and hand off");
    await runtime.session.waitForIdle();
    faux.setResponses([fauxAssistantMessage("Continued after the typed handoff")]);
    await runtime.session.prompt(
      `/${ours.invocationName} navigate ${checkpoint.entry.id} Typed continuation`,
    );
    await runtime.session.waitForIdle();
    // Both navigate to the same checkpoint, so each handoff sits on its own branch.
    const delivered = handoffs(runtime.session.sessionManager.getEntries()).map((entry) =>
      JSON.stringify(entry),
    );
    assert.equal(delivered.length, 2);
    assert.match(delivered[0] ?? "", /Agent-authored session handoff/);
    assert.match(delivered[1] ?? "", /User-authored session handoff/);
    assert.equal(otherCalls, 0);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});
