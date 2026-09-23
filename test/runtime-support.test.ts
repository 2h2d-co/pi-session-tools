import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  getPackageDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_TYPE, lastCheckpoint } from "../src/history.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dependency = join(root, "node_modules/@earendil-works/pi-coding-agent");

test("in-process tests use the repository's Pi dependency for package resources", async () => {
  // The Mise test tasks bind PI_PACKAGE_DIR here so an inherited global override cannot
  // select another runtime's version, docs, or themes for the SDK under test.
  const manifest: unknown = JSON.parse(await readFile(join(dependency, "package.json"), "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
  assert.equal(VERSION, manifest.version);
  assert.equal(await realpath(getPackageDir()), await realpath(dependency));
});

test("an older Pi disables only checkpoint markers and session_handoff", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-session-tools-runtime-support-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const loaded = await discoverAndLoadExtensions(
    [join(root, "extensions/index.ts")],
    cwd,
    agentDir,
  );
  assert.deepEqual(loaded.errors, []);
  const manager = SessionManager.inMemory(cwd);
  // Pi before 0.87 has no canonical session projection on its session manager. The
  // runner below is the only consumer, so Pi's own agent loop is not affected.
  Object.defineProperty(manager, "buildSessionProjection", { value: undefined });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    manager,
    new ModelRegistry(modelRuntime),
  );
  const errors: string[] = [];
  runner.onError((error) => errors.push(error.error));
  const unused = (name: string) => () => {
    throw new Error(`${name} is not used by this test.`);
  };
  runner.bindCore(
    {
      sendMessage: unused("sendMessage"),
      sendUserMessage: unused("sendUserMessage"),
      appendEntry: (customType, data) => {
        manager.appendCustomEntry(customType, data);
      },
      setSessionName: unused("setSessionName"),
      getSessionName: () => undefined,
      setLabel: unused("setLabel"),
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: unused("setActiveTools"),
      refreshTools: unused("refreshTools"),
      getCommands: () => [],
      setModel: unused("setModel"),
      getThinkingLevel: () => "off",
      setThinkingLevel: unused("setThinkingLevel"),
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: unused("abort"),
      hasPendingMessages: () => false,
      shutdown: unused("shutdown"),
      getContextUsage: () => undefined,
      compact: unused("compact"),
      getSystemPrompt: () => "",
    },
  );
  const notices: string[] = [];
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify: (message, type) => {
        notices.push(`${type ?? "info"}: ${message}`);
      },
    },
    "print",
  );

  await runner.emit({ type: "session_start", reason: "startup" });
  assert.deepEqual(notices, [
    "error: pi-session-tools requires Pi 0.87.0 or later. Checkpoint markers and session_handoff are disabled. Checkpoint recording and session_inspect remain available.",
  ]);

  const id = manager.appendMessage(fauxAssistantMessage("A completed response"));
  const checkpoint = lastCheckpoint(manager);
  assert.ok(checkpoint);
  assert.equal(checkpoint.entry.id, id);
  const preview = {
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: false,
  };
  await runner.emitBoundary(
    {
      type: "turn_end",
      turnIndex: 0,
      message: checkpoint.entry.message,
      toolResults: [],
      messageEntryId: id,
      toolResultEntryIds: [],
      outcome: "completed",
    },
    () => preview,
  );
  const markers = manager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE);
  assert.equal(markers.length, 1, "Checkpoint recording stays active.");
  assert.match(JSON.stringify(markers), new RegExp(id));

  const inspect = runner.getToolDefinition("session_inspect");
  assert.ok(inspect);
  const inspection = await inspect.execute(
    "inspect-call",
    { view: "overview" },
    undefined,
    undefined,
    runner.createContext(),
  );
  assert.match(JSON.stringify(inspection.content), new RegExp(id));

  const projected = await runner.emitContext([checkpoint.entry.message]);
  assert.deepEqual(projected, [checkpoint.entry.message], "No marker is projected.");

  const handoff = runner.getToolDefinition("session_handoff");
  assert.ok(handoff);
  await assert.rejects(
    handoff.execute(
      "handoff-call",
      {
        expectedSessionId: manager.getSessionId(),
        mode: "new",
        handoff: { kind: "inline", text: "Continue" },
      },
      undefined,
      undefined,
      runner.createContext(),
    ),
    /session_handoff requires Pi 0\.87\.0 or later/,
  );
  assert.deepEqual(
    manager.getEntries().map((entry) => entry.type),
    ["message", "custom"],
    "No handoff record is written.",
  );
  assert.deepEqual(errors, []);
});
