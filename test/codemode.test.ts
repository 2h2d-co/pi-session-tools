import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { lastCheckpoint } from "../src/history.ts";
import { testRuntime } from "./runtime.ts";

test("tools declare their exposure and behavior hints", async () => {
  const { runtime } = await testRuntime();
  try {
    const tools = new Map(runtime.session.getAllTools().map((tool) => [tool.name, tool]));
    const inspect = tools.get("session_inspect");
    assert.ok(inspect);
    assert.equal(inspect.exposure, "direct");
    assert.deepEqual(inspect.annotations, { readOnlyHint: true, openWorldHint: false });
    const handoff = tools.get("session_handoff");
    assert.ok(handoff);
    assert.equal(handoff.exposure, "model-only");
    assert.deepEqual(handoff.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    assert.deepEqual(runtime.session.getActiveToolNames().toSorted(), [
      "session_handoff",
      "session_inspect",
    ]);
  } finally {
    await runtime.dispose();
  }
});

test("codemode scripts receive structured inspections and cannot reach session_handoff", async () => {
  const { runtime, faux, errors } = await testRuntime(createCodemodeExtension());
  try {
    faux.setResponses([fauxAssistantMessage("A completed response")]);
    await runtime.session.prompt("Start");
    const checkpoint = lastCheckpoint(runtime.session.sessionManager);
    assert.ok(checkpoint);

    runtime.session.setActiveToolsByName([...runtime.session.getActiveToolNames(), "codemode"]);
    const code = [
      'const inspected = await tools.session_inspect({ view: "overview" });',
      "return JSON.stringify({",
      "  kind: typeof inspected,",
      "  entryIds: inspected.history.checkpoints.map((item) => item.entryId),",
      "  operations: inspected.operations,",
      '  handoff: "session_handoff" in tools,',
      "  listed: ALL_TOOLS.map((tool) => tool.name).toSorted(),",
      "});",
    ].join("\n");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Inspected from a script"),
    ]);
    await runtime.session.prompt("Inspect from a script");

    const result = runtime.session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "codemode",
    );
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, false, JSON.stringify(result.content));
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    const payload = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    assert.deepEqual(JSON.parse(payload), {
      kind: "object",
      entryIds: [checkpoint.entry.id],
      operations: [],
      handoff: false,
      listed: ["session_inspect"],
    });
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});
