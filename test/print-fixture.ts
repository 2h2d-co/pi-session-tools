import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { runPrintMode } from "@earendil-works/pi-coding-agent";
import { HANDOFF_TYPE, lastCheckpoint } from "../src/history.ts";
import { testRuntime } from "./runtime.ts";

const mode = process.argv[2] ?? "new";
const outputMode = process.argv[3] === "json" ? "json" : "text";
const { runtime, faux } = await testRuntime();
faux.setResponses([fauxAssistantMessage("A plan worth retaining. ".repeat(100))]);
await runtime.session.prompt("Initial request");
const checkpoint = lastCheckpoint(runtime.session.sessionManager);
assert.ok(checkpoint);
const sessionId = runtime.session.sessionId;
const resume: FauxResponseFactory = (context) => {
  if (
    mode === "compact" &&
    !JSON.stringify(context.messages).includes("[Agent-authored session handoff]")
  ) {
    faux.appendResponses([resume]);
    return fauxAssistantMessage("Compaction summary");
  }
  return fauxAssistantMessage("print-handoff-completed");
};
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("session_handoff", {
      expectedSessionId: sessionId,
      mode,
      ...(mode === "navigate" || mode === "fork" ? { targetEntryId: checkpoint.entry.id } : {}),
      handoff: { kind: "inline", text: "Continue the plan" },
    }),
  ),
  resume,
]);
const code = await runPrintMode(runtime, { mode: outputMode, initialMessage: "Hand off now" });
assert.equal(code, 0);
const handoffs = runtime.session.sessionManager
  .getBranch()
  .filter((entry) => entry.type === "custom_message" && entry.customType === HANDOFF_TYPE);
assert.equal(handoffs.length, 1);
assert.equal(faux.getPendingResponseCount(), 0);
assert.equal(runtime.session.messages.at(-1)?.role, "assistant");
