import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { checkpoints, entryText, inspectSession, requireCheckpoint } from "../src/history.ts";

function readObject(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

test("only complete assistant responses and complete tool batches are checkpoints", () => {
  const sm = SessionManager.inMemory();
  const user = sm.appendMessage({ role: "user", content: "Investigate", timestamp: 1 });
  const text = sm.appendMessage(fauxAssistantMessage("Start here"));
  const calls = sm.appendMessage(
    fauxAssistantMessage([
      fauxToolCall("read", { path: "a" }, { id: "one" }),
      fauxToolCall("read", { path: "b" }, { id: "two" }),
    ]),
  );
  const first = sm.appendMessage({
    role: "toolResult",
    toolCallId: "one",
    toolName: "read",
    content: [{ type: "text", text: "a" }],
    isError: false,
    timestamp: 2,
  });
  const last = sm.appendMessage({
    role: "toolResult",
    toolCallId: "two",
    toolName: "read",
    content: [{ type: "text", text: "b" }],
    isError: true,
    timestamp: 3,
  });
  assert.deepEqual([...checkpoints(sm.getEntries()).keys()], [text, last]);
  assert.equal(requireCheckpoint(sm, last).assistantId, calls);
  for (const id of [user, calls, first, "missing"]) {
    assert.throws(() => requireCheckpoint(sm, id), /not a completed turn/);
  }
});

test("invalid, truncated, and interrupted tool protocols are not checkpoints", () => {
  for (const kind of ["orphan", "truncated", "interleaved", "duplicate"]) {
    const sm = SessionManager.inMemory();
    if (kind !== "orphan") {
      sm.appendMessage(
        fauxAssistantMessage(
          kind === "duplicate"
            ? [fauxToolCall("read", {}, { id: "one" }), fauxToolCall("read", {}, { id: "one" })]
            : fauxToolCall("read", {}, { id: "one" }),
          { stopReason: kind === "truncated" ? "length" : "toolUse" },
        ),
      );
    }
    if (kind === "interleaved") sm.appendCustomMessageEntry("other", "interrupt", false);
    const last = sm.appendMessage({
      role: "toolResult",
      toolCallId: "one",
      toolName: "read",
      content: [],
      isError: false,
      timestamp: 2,
    });
    assert.throws(() => requireCheckpoint(sm, last), /not a completed turn/);
  }
});

test("a later completed turn remains usable after a provider error or aborted response", () => {
  for (const stopReason of ["error", "aborted", "length"] as const) {
    const sm = SessionManager.inMemory();
    sm.appendMessage(
      fauxAssistantMessage(fauxToolCall("read", {}, { id: "partial" }), { stopReason }),
    );
    if (stopReason === "length") {
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "partial",
        toolName: "read",
        content: [{ type: "text", text: "Truncated call was not executed" }],
        isError: true,
        timestamp: 1,
      });
    }
    sm.appendMessage({ role: "user", content: "Try again", timestamp: 2 });
    const checkpoint = sm.appendMessage(fauxAssistantMessage("Recovered"));
    assert.equal(requireCheckpoint(sm, checkpoint).entry.id, checkpoint);
    assert.deepEqual([...checkpoints(sm.getEntries()).keys()], [checkpoint]);
  }
});

test("tree discovery preserves inactive branches, parent checkpoints, and labels", () => {
  const sm = SessionManager.inMemory();
  const root = sm.appendMessage(fauxAssistantMessage("Plan"));
  const abandoned = sm.appendMessage(fauxAssistantMessage("Investigated retries"));
  sm.appendLabelChange(abandoned, "retry-evidence");
  sm.branch(root);
  const active = sm.appendMessage(fauxAssistantMessage("Implement cache"));
  const index = checkpoints(sm.getEntries());
  assert.equal(index.get(active)?.parentCheckpointId, root);
  assert.equal(index.get(abandoned)?.parentCheckpointId, root);
  const result = readObject(inspectSession(sm, { view: "search", query: "retry-evidence" }));
  assert.equal(result["total"], 1);
  assert.match(JSON.stringify(result), /other-branch/);
  assert.match(JSON.stringify(result), new RegExp(abandoned));
  assert.equal(sm.getLeafId(), active);
  const children = readObject(inspectSession(sm, { view: "children", entryId: root }));
  assert.equal(children["total"], 2);
});

test("pagination has a stable snapshot and rejects mismatched queries", () => {
  const sm = SessionManager.inMemory();
  const first = sm.appendMessage(fauxAssistantMessage("One"));
  const second = sm.appendMessage(fauxAssistantMessage("Two"));
  const page = readObject(inspectSession(sm, { view: "overview", limit: 1 }));
  const cursor = page["nextCursor"];
  assert.equal(typeof cursor, "string");
  if (typeof cursor !== "string") throw new Error("Expected cursor");
  sm.appendMessage(fauxAssistantMessage("New after snapshot"));
  const next = readObject(inspectSession(sm, { view: "overview", limit: 1, cursor }));
  assert.equal(next["total"], 2);
  assert.equal(next["nextCursor"], null);
  assert.match(JSON.stringify(next["checkpoints"]), new RegExp(second));
  assert.doesNotMatch(JSON.stringify(next["checkpoints"]), new RegExp(`"entryId":"${first}"`));
  assert.throws(
    () => inspectSession(sm, { view: "ancestors", limit: 1, cursor }),
    /Invalid cursor/,
  );
  assert.throws(
    () => inspectSession(sm, { view: "overview", cursor: "garbage" }),
    /Invalid cursor/,
  );
});

test("read pages omit thinking and images and honor zero neighboring entries", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(fauxAssistantMessage("before"));
  const id = sm.appendMessage(
    fauxAssistantMessage([
      fauxThinking("do-not-expose-reasoning"),
      { type: "text", text: "x".repeat(9000) },
    ]),
  );
  const read = readObject(inspectSession(sm, { view: "read", entryId: id, before: 0, after: 0 }));
  assert.equal(typeof read["content"], "string");
  assert.equal(String(read["content"]).length, 8000);
  assert.deepEqual(read["before"], []);
  assert.doesNotMatch(JSON.stringify(read), /do-not-expose/);
  const cursor = read["nextCursor"];
  assert.ok(typeof cursor === "string");
  const next = readObject(
    inspectSession(sm, { view: "read", entryId: id, before: 0, after: 0, cursor }),
  );
  assert.equal(String(next["content"]).length, 1000);
  assert.equal(next["nextCursor"], null);
});

test("tool output is opt-in and compacted-away checkpoints remain discoverable", () => {
  const sm = SessionManager.inMemory();
  const old = sm.appendMessage(fauxAssistantMessage("Earlier evidence"));
  const kept = sm.appendMessage({ role: "user", content: "continue", timestamp: 1 });
  sm.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "one" })));
  const result = sm.appendMessage({
    role: "toolResult",
    toolCallId: "one",
    toolName: "read",
    content: [{ type: "text", text: "explicit output" }],
    isError: false,
    timestamp: 2,
  });
  sm.appendCompaction("Summary", kept, 20000);
  const entry = sm.getEntry(result);
  assert.ok(entry);
  assert.doesNotMatch(entryText(entry), /explicit output/);
  assert.match(entryText(entry, true), /explicit output/);
  assert.equal(requireCheckpoint(sm, old).entry.id, old);
  const found = readObject(inspectSession(sm, { view: "search", query: "Earlier" }));
  assert.equal(found["total"], 1);
  assert.throws(() => inspectSession(sm, { view: "search" }), /requires query/);
  assert.throws(() => inspectSession(sm, { view: "read" }), /requires entryId/);
});

test("inspection reports a broken compaction replay rather than offering a usable target", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "one" })));
  const result = sm.appendMessage({
    role: "toolResult",
    toolCallId: "one",
    toolName: "read",
    content: [],
    isError: false,
    timestamp: 1,
  });
  sm.appendCompaction("Invalid extension compaction", result, 10000);
  const last = sm.appendMessage(fauxAssistantMessage("Later turn"));
  assert.throws(() => requireCheckpoint(sm, last), /unmatched tool result/);
  const page = inspectSession(sm, { view: "search", query: "Later turn" });
  assert.match(JSON.stringify(page), /"canContinue":false/);
});
