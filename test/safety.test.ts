import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { HANDOFF_TYPE, JOURNAL_TYPE, lastCheckpoint } from "../src/history.ts";
import { testRuntime } from "./runtime.ts";

function failed(manager: SessionManager): boolean {
  return manager.getEntries().some((entry) => {
    const data: unknown = entry.type === "custom" ? entry.data : undefined;
    return typeof data === "object" && data !== null && "phase" in data && data.phase === "failed";
  });
}

test("a handoff batched with another tool is rejected without changing context", async () => {
  const { runtime, faux, errors } = await testRuntime();
  try {
    const sessionId = runtime.session.sessionId;
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("session_handoff", {
          expectedSessionId: sessionId,
          mode: "new",
          handoff: { kind: "inline", text: "Continue" },
        }),
        fauxToolCall("session_inspect", { view: "overview" }),
      ]),
      fauxAssistantMessage("The batched handoff was rejected"),
    ]);
    await runtime.session.prompt("Inspect and hand off");
    assert.equal(runtime.session.sessionId, sessionId);
    assert.ok(
      runtime.session.messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "session_handoff" &&
          message.isError,
      ),
    );
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("incoming user input cancels an accepted handoff and is not lost", async () => {
  const { runtime, faux, errors } = await testRuntime((pi) => {
    pi.on("tool_result", (event) => {
      if (event.toolName === "session_handoff") {
        pi.sendUserMessage("New restriction: do not proceed", { deliverAs: "followUp" });
      }
    });
  });
  try {
    const sessionId = runtime.session.sessionId;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("session_handoff", {
          expectedSessionId: sessionId,
          mode: "new",
          handoff: { kind: "inline", text: "Continue" },
        }),
      ),
      fauxAssistantMessage("Respecting the new restriction"),
    ]);
    await runtime.session.prompt("Hand off");
    assert.equal(runtime.session.sessionId, sessionId);
    assert.equal(failed(runtime.session.sessionManager), true);
    assert.match(JSON.stringify(runtime.session.messages), /New restriction: do not proceed/);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

for (const mode of ["navigate", "fork", "new", "compact"] as const) {
  test(`extension cancellation prevents ${mode} handoff delivery`, async () => {
    const cancel: ExtensionFactory = (pi) => {
      pi.on("session_before_tree", () => ({ cancel: true }));
      pi.on("session_before_fork", () => ({ cancel: true }));
      pi.on("session_before_switch", () => ({ cancel: true }));
      pi.on("session_before_compact", () => ({ cancel: true }));
    };
    const { runtime, faux, errors } = await testRuntime(cancel);
    try {
      faux.setResponses([fauxAssistantMessage("An approved plan. ".repeat(200))]);
      await runtime.session.prompt("Plan");
      const checkpoint = lastCheckpoint(runtime.session.sessionManager);
      assert.ok(checkpoint);
      const sessionId = runtime.session.sessionId;
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("session_handoff", {
            expectedSessionId: sessionId,
            mode,
            ...(mode === "navigate" || mode === "fork"
              ? { targetEntryId: checkpoint.entry.id }
              : {}),
            handoff: { kind: "inline", text: "Carry the plan" },
          }),
        ),
      ]);
      await runtime.session.prompt("Hand off");
      assert.equal(runtime.session.sessionId, sessionId);
      assert.equal(failed(runtime.session.sessionManager), true);
      assert.ok(
        !runtime.session.sessionManager
          .getEntries()
          .some((entry) => entry.type === "custom_message" && entry.customType === HANDOFF_TYPE),
      );
      assert.deepEqual(errors, []);
    } finally {
      await runtime.dispose();
    }
  });
}

test("a findings-file mutation after acceptance stops before navigation", async () => {
  let filename = "";
  const { runtime, faux, cwd } = await testRuntime((pi) => {
    pi.on("tool_result", async (event) => {
      if (event.toolName === "session_handoff") await writeFile(filename, "New evidence");
    });
  });
  try {
    filename = join(cwd, "findings.md");
    await writeFile(filename, "Original evidence");
    const sessionId = runtime.session.sessionId;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("session_handoff", {
          expectedSessionId: sessionId,
          mode: "new",
          handoff: { kind: "file", path: filename, instruction: "Read before continuing" },
        }),
      ),
    ]);
    await runtime.session.prompt("Hand off");
    assert.equal(runtime.session.sessionId, sessionId);
    assert.equal(failed(runtime.session.sessionManager), true);
    assert.match(JSON.stringify(runtime.session.messages), /changed after/);
  } finally {
    await runtime.dispose();
  }
});

test("interrupted journal entries are inspectable but are never replayed on resume", async () => {
  const { runtime, faux, errors } = await testRuntime();
  try {
    faux.setResponses([fauxAssistantMessage("Initial response")]);
    await runtime.session.prompt("Start");
    const source = runtime.session.sessionManager;
    source.appendCustomEntry(JOURNAL_TYPE, {
      operationId: "interrupted-example",
      phase: "accepted",
      mode: "new",
    });
    const file = source.getSessionFile();
    assert.ok(file);
    await runtime.newSession();
    await runtime.switchSession(file);
    faux.setResponses([
      (context) => {
        assert.match(JSON.stringify(context.messages), /interrupted-example/);
        assert.match(JSON.stringify(context.messages), /not replayed/);
        return fauxAssistantMessage("Recovery requires inspection");
      },
    ]);
    await runtime.session.prompt("Resume");
    await runtime.session.prompt("/session-tools-apply-handoff interrupted-example");
    assert.equal(runtime.session.sessionId, source.getSessionId());
    assert.equal(faux.state.callCount, 2);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("a file change after navigation reports a partial operation without undoing history", async () => {
  let filename = "";
  const { runtime, faux, cwd } = await testRuntime((pi) => {
    pi.on("session_tree", async () => {
      await writeFile(filename, "Changed at destination");
    });
  });
  try {
    filename = join(cwd, "findings.md");
    await writeFile(filename, "Original findings");
    faux.setResponses([fauxAssistantMessage("Checkpoint")]);
    await runtime.session.prompt("Plan");
    const target = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(target);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("session_handoff", {
          expectedSessionId: runtime.session.sessionId,
          mode: "navigate",
          targetEntryId: target.entry.id,
          handoff: { kind: "file", path: filename, instruction: "Read" },
        }),
      ),
    ]);
    await runtime.session.prompt("Continue");
    const sm = runtime.session.sessionManager;
    assert.equal(failed(sm), true);
    assert.ok(sm.getBranch().some((entry) => entry.id === target.entry.id));
    assert.ok(sm.getEntries().length > sm.getBranch().length);
    assert.ok(
      !sm
        .getEntries()
        .some((entry) => entry.type === "custom_message" && entry.customType === HANDOFF_TYPE),
    );
  } finally {
    await runtime.dispose();
  }
});

test("user abort cancels an accepted handoff", async () => {
  const { runtime, faux } = await testRuntime((pi) => {
    pi.on("tool_result", (event, ctx) => {
      if (event.toolName === "session_handoff") ctx.abort();
    });
  });
  try {
    const sessionId = runtime.session.sessionId;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("session_handoff", {
          expectedSessionId: sessionId,
          mode: "new",
          handoff: { kind: "inline", text: "Do not execute after abort" },
        }),
      ),
    ]);
    await runtime.session.prompt("Hand off");
    assert.equal(runtime.session.sessionId, sessionId);
    assert.equal(failed(runtime.session.sessionManager), true);
  } finally {
    await runtime.dispose();
  }
});

for (const mode of ["fork", "new"]) {
  test(`${mode} rejects ephemeral source sessions rather than losing source history`, async () => {
    const { runtime, faux } = await testRuntime(undefined, "print", false);
    try {
      const sessionId = runtime.session.sessionId;
      const target = runtime.session.sessionManager.appendMessage(fauxAssistantMessage("Plan"));
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("session_handoff", {
            expectedSessionId: sessionId,
            mode,
            ...(mode === "fork" ? { targetEntryId: target } : {}),
            handoff: { kind: "inline", text: "Continue" },
          }),
        ),
        fauxAssistantMessage("Cannot replace an ephemeral session"),
      ]);
      await runtime.session.prompt("Hand off");
      assert.equal(runtime.session.sessionId, sessionId);
      assert.match(JSON.stringify(runtime.session.messages), /persisted session/);
    } finally {
      await runtime.dispose();
    }
  });
}

test("an unsubmitted TUI editor draft prevents session replacement", async (context) => {
  const { runtime, faux } = await testRuntime((pi) => {
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName === "session_handoff") {
        context.mock.method(ctx.ui, "getEditorText", () => "An unsubmitted user instruction");
      }
    });
  }, "tui");
  try {
    const sessionId = runtime.session.sessionId;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("session_handoff", {
          expectedSessionId: sessionId,
          mode: "new",
          handoff: { kind: "inline", text: "Continue" },
        }),
      ),
      fauxAssistantMessage("Preserved the editor draft"),
    ]);
    await runtime.session.prompt("Hand off");
    assert.equal(runtime.session.sessionId, sessionId);
    assert.match(JSON.stringify(runtime.session.messages), /save the editor draft/);
  } finally {
    await runtime.dispose();
  }
});
