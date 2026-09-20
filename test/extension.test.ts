import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { CHECKPOINT_TYPE, HANDOFF_TYPE, lastCheckpoint } from "../src/history.ts";
import { testRuntime, waitUntil } from "./runtime.ts";

test("real Pi emits non-triggering checkpoint metadata after a completed turn", async () => {
  const { runtime, faux, errors } = await testRuntime();
  try {
    faux.setResponses([fauxAssistantMessage("A completed response")]);
    await runtime.session.prompt("Start");
    const checkpoint = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(checkpoint);
    const markers = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE);
    assert.equal(markers.length, 1);
    assert.match(JSON.stringify(markers), new RegExp(checkpoint.entry.id));
    assert.equal(faux.state.callCount, 1);
    faux.setResponses([
      (context) => {
        assert.match(JSON.stringify(context.messages), new RegExp(`entry=${checkpoint.entry.id}`));
        return fauxAssistantMessage("Checkpoint is available");
      },
    ]);
    await runtime.session.prompt("Continue");
    assert.equal(runtime.session.messages.at(-1)?.role, "assistant");
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

for (const mode of ["navigate", "fork", "new", "compact"] as const) {
  test(`real Pi ${mode} appends one handoff after the operation and resumes`, async () => {
    const { runtime, faux, errors } = await testRuntime();
    try {
      faux.setResponses([fauxAssistantMessage("Approved plan. ".repeat(200))]);
      await runtime.session.prompt("Keep the current restrictions");
      const checkpoint = lastCheckpoint(runtime.session.sessionManager);
      assert.ok(checkpoint);
      const sourceManager = runtime.session.sessionManager;
      const sourceSessionId = sourceManager.getSessionId();
      const input = {
        expectedSessionId: sourceSessionId,
        mode,
        ...(mode === "navigate" || mode === "fork" ? { targetEntryId: checkpoint.entry.id } : {}),
        ...(mode === "compact"
          ? { compactionInstructions: "Preserve the user's restrictions" }
          : {}),
        handoff: {
          kind: "inline",
          text: "The investigation is complete. Implement without schema changes.",
        },
      };
      const resume: FauxResponseFactory = (context) => {
        const text = JSON.stringify(context.messages);
        if (mode === "compact" && !text.includes("[Agent-authored session handoff]")) {
          faux.appendResponses([resume]);
          return fauxAssistantMessage("Compacted history with restrictions.");
        }
        assert.match(text, /Agent-authored session handoff/);
        assert.match(text, /without schema changes/);
        return fauxAssistantMessage("Continued after handoff");
      };
      faux.setResponses([fauxAssistantMessage(fauxToolCall("session_handoff", input)), resume]);
      await runtime.session.prompt("Investigate and hand off");
      await waitUntil(() =>
        runtime.session.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some(
              (block) => block.type === "text" && block.text === "Continued after handoff",
            ),
        ),
      );
      await runtime.session.waitForIdle();
      const branch = runtime.session.sessionManager.getBranch();
      const handoffs = branch.filter(
        (entry) => entry.type === "custom_message" && entry.customType === HANDOFF_TYPE,
      );
      assert.equal(handoffs.length, 1);
      const handoff = handoffs[0];
      assert.ok(handoff);
      assert.deepEqual(errors, []);
      if (mode === "fork" || mode === "new") {
        assert.notEqual(runtime.session.sessionId, sourceSessionId);
        assert.equal(
          runtime.session.sessionManager.getHeader()?.parentSession,
          sourceManager.getSessionFile(),
        );
      } else {
        assert.equal(runtime.session.sessionId, sourceSessionId);
      }
      if (mode === "new") {
        const firstMessage = branch.find(
          (entry) => entry.type === "message" || entry.type === "custom_message",
        );
        assert.equal(firstMessage, handoffs[0]);
        assert.ok(!branch.some((entry) => entry.id === checkpoint.entry.id));
      } else if (mode === "compact") {
        const compactIndex = branch.findIndex((entry) => entry.type === "compaction");
        assert.ok(compactIndex >= 0 && compactIndex < branch.indexOf(handoff));
      } else {
        assert.ok(branch.some((entry) => entry.id === checkpoint.entry.id));
        assert.ok(
          !branch.some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "user" &&
              entry.message.content === "Investigate and hand off",
          ),
        );
      }
      assert.ok(sourceManager.getEntries().length >= 3);
    } finally {
      await runtime.dispose();
    }
  });
}

for (const mode of ["new", "fork"] as const) {
  test(`${mode} finishes the host replacement action before starting its continuation`, async (context) => {
    const { runtime, faux } = await testRuntime(undefined, "tui");
    try {
      faux.setResponses([fauxAssistantMessage("Plan")]);
      await runtime.session.prompt("Start");
      const checkpoint = lastCheckpoint(runtime.session.sessionManager);
      assert.ok(checkpoint);
      let hostFinished = false;
      let observed = false;
      if (mode === "new") {
        const original = runtime.newSession.bind(runtime);
        context.mock.method(runtime, "newSession", async (...args: Parameters<typeof original>) => {
          const result = await original(...args);
          hostFinished = true;
          return result;
        });
      } else {
        const original = runtime.fork.bind(runtime);
        context.mock.method(runtime, "fork", async (...args: Parameters<typeof original>) => {
          const result = await original(...args);
          hostFinished = true;
          return result;
        });
      }
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("session_handoff", {
            expectedSessionId: runtime.session.sessionId,
            mode,
            ...(mode === "fork" ? { targetEntryId: checkpoint.entry.id } : {}),
            handoff: { kind: "inline", text: "Continue" },
          }),
        ),
        () => {
          observed = hostFinished;
          return fauxAssistantMessage("Resumed after host action");
        },
      ]);
      await runtime.session.prompt("Hand off");
      assert.equal(observed, true);
    } finally {
      await runtime.dispose();
    }
  });
}

test("navigation can return to a preserved future branch", async () => {
  const { runtime, faux, errors } = await testRuntime(undefined, "rpc");
  try {
    faux.setResponses([fauxAssistantMessage("Initial plan")]);
    await runtime.session.prompt("Plan");
    const root = lastCheckpoint(runtime.session.sessionManager);
    faux.setResponses([fauxAssistantMessage("Evidence on the original future branch")]);
    await runtime.session.prompt("Investigate");
    const future = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(root && future);
    for (const target of [root, future]) {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("session_handoff", {
            expectedSessionId: runtime.session.sessionId,
            mode: "navigate",
            targetEntryId: target.entry.id,
            handoff: { kind: "inline", text: "Carry findings into the selected branch" },
          }),
        ),
        fauxAssistantMessage("Continued"),
      ]);
      await runtime.session.prompt("Navigate");
      assert.ok(
        runtime.session.sessionManager.getBranch().some((entry) => entry.id === target.entry.id),
      );
    }
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("a continuation can hand off again without a stale context or an idle deadlock", async () => {
  const { runtime, faux, errors } = await testRuntime();
  try {
    const firstSessionId = runtime.session.sessionId;
    const next = () =>
      fauxAssistantMessage(
        fauxToolCall("session_handoff", {
          expectedSessionId: runtime.session.sessionId,
          mode: "new",
          handoff: { kind: "inline", text: "Continue without granting new permissions" },
        }),
      );
    faux.setResponses([
      next,
      (context) => {
        assert.notEqual(runtime.session.sessionId, firstSessionId);
        assert.match(JSON.stringify(context.messages), new RegExp(runtime.session.sessionId));
        return next();
      },
      fauxAssistantMessage("Finished the second continuation"),
    ]);
    await runtime.session.prompt("Hand off twice");
    assert.match(
      JSON.stringify(runtime.session.messages.at(-1)),
      /Finished the second continuation/,
    );
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});
