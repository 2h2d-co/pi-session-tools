import assert from "node:assert/strict";
import { execFile, type ExecFileOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HANDOFF_TYPE, lastCheckpoint } from "../src/history.ts";
import { archiveEntries, expectedArchiveEntries, packageArchive } from "./package-archive.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

function exec(command: string, args: string[], options: ExecFileOptions = {}) {
  const result = promisify(execFile)(command, args, { ...options, encoding: "utf8" });
  // Print mode reads piped input before processing prompts. Close the unused pipe.
  result.child.stdin?.end();
  return result;
}

/** Extract the exact candidate package and configure an isolated packaged Pi CLI. */
async function packagedCli(t: TestContext) {
  const token = process.env["PI_SESSION_TOOLS_LIVE_API_KEY"];
  assert.ok(token, "PI_SESSION_TOOLS_LIVE_API_KEY is required.");
  const temporary = await mkdtemp(join(tmpdir(), "session-tools-live-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  // A release passes its exact staged-index archive; otherwise pack this worktree.
  const archive = await packageArchive(root, temporary, process.env["PI_PACKAGE_ARCHIVE"]);
  assert.deepEqual(await archiveEntries(archive), await expectedArchiveEntries(root));
  await exec("tar", ["-xzf", archive, "-C", temporary]);
  const cli = await realpath(
    process.env["PI_TEST_CLI_PATH"] ??
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
  );
  const agent = join(temporary, "agent");
  await mkdir(agent);
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
    // Bind Pi's package resources to the selected executable, not an inherited override.
    PI_PACKAGE_DIR: resolve(dirname(cli), "../.."),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
  assert.equal((await exec(process.execPath, [cli, "--version"], { env })).stdout.trim(), "0.99.1");
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: { "openai-codex": { apiKey: "$PI_SESSION_TOOLS_LIVE_API_KEY" } },
    }),
  );
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      transport: "sse",
      retry: { enabled: false, provider: { timeoutMs: 60_000, maxRetries: 0 } },
      compaction: { enabled: false, keepRecentTokens: 1 },
    }),
  );
  return { temporary, cli, env, extension: join(temporary, "package") };
}

test(
  "live packaged Pi CLI completes every handoff mode without losing source history",
  { skip: process.env["PI_SESSION_TOOLS_LIVE_TEST"] !== "1", timeout: 600_000 },
  async (t) => {
    const { temporary, cli, env, extension } = await packagedCli(t);
    for (const mode of ["navigate", "fork", "compact", "new"]) {
      const cwd = join(temporary, mode);
      const sessions = join(cwd, "sessions");
      await mkdir(sessions, { recursive: true });
      const source = join(sessions, "source.jsonl");
      const marker = `HANDOFF_${mode.toUpperCase()}_OK`;
      await writeFile(join(cwd, "facts.txt"), "Lantern, TypeScript, SQLite, port 4317.\n");
      const args = [
        cli,
        "--print",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--tools",
        "read,session_inspect,session_handoff",
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-luna",
        "--thinking",
        "low",
        "--session",
        source,
        "--session-dir",
        sessions,
        "-e",
        extension,
        "--append-system-prompt",
        `The completion marker is ${marker}. After the agent-authored handoff, reply with it.`,
      ];
      const seed = await exec(
        process.execPath,
        [
          ...args,
          "Read facts.txt with the read tool and call session_inspect with view overview once. " +
            "Then write a 150-word plan for the synthetic project in that file. " +
            "Do not change files or call session_handoff.",
        ],
        { cwd, env, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
      );
      assert.doesNotMatch(seed.stderr, /Failed to load extension|Extension error|not a function/);
      const before = await readFile(source, "utf8");
      const manager = SessionManager.open(source);
      assert.ok(
        manager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolName === "session_inspect" &&
              !entry.message.isError,
          ),
      );
      const checkpoint = lastCheckpoint(manager);
      assert.ok(checkpoint);
      assert.ok(
        manager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolName === "read" &&
              !entry.message.isError,
          ),
      );
      const input = {
        expectedSessionId: manager.getSessionId(),
        mode,
        ...(mode === "navigate" || mode === "fork" ? { targetEntryId: checkpoint.entry.id } : {}),
        handoff: {
          kind: "inline",
          text:
            "The synthetic project is Lantern, TypeScript, SQLite, port 4317. " +
            "Reply with only the completion marker from the current system instructions. " +
            "Do not call tools or perform another handoff.",
        },
      };
      const result = await exec(
        process.execPath,
        [
          ...args,
          `Call session_handoff exactly once, alone, with these arguments: ${JSON.stringify(input)}`,
        ],
        { cwd, env, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 },
      );
      assert.match(result.stdout, new RegExp(marker));
      assert.doesNotMatch(result.stderr, /Failed to load extension|Extension error|not a function/);
      assert.ok(
        (await readFile(source, "utf8")).startsWith(before),
        "Source history is preserved.",
      );
      const destinations = [];
      for (const file of await readdir(sessions)) {
        if (!file.endsWith(".jsonl")) continue;
        const session = SessionManager.open(join(sessions, file));
        const handoffs = session
          .getBranch()
          .filter((entry) => entry.type === "custom_message" && entry.customType === HANDOFF_TYPE);
        if (handoffs.length > 0) {
          assert.equal(handoffs.length, 1);
          destinations.push(session);
        }
      }
      assert.equal(destinations.length, 1, "Exactly one destination receives the handoff.");
      const destination = destinations[0];
      assert.ok(destination);
      assert.equal(
        destination.getSessionId() === manager.getSessionId(),
        mode === "navigate" || mode === "compact",
      );
      if (mode === "compact") {
        assert.ok(destination.getBranch().some((entry) => entry.type === "compaction"));
      }
      const assistant = destination.buildSessionContext().messages.at(-1);
      assert.ok(assistant?.role === "assistant");
      assert.equal(assistant.stopReason, "stop", "The continuation must complete successfully.");
      assert.ok(
        assistant.content.some((block) => block.type === "text" && block.text.includes(marker)),
      );
      t.diagnostic(`Pi 0.99.1: live ${mode} handoff and automatic continuation passed.`);
    }
  },
);

test(
  "live packaged Pi CLI gives codemode scripts structured inspections but not session_handoff",
  { skip: process.env["PI_SESSION_TOOLS_LIVE_TEST"] !== "1", timeout: 300_000 },
  async (t) => {
    const { temporary, cli, env, extension } = await packagedCli(t);
    const cwd = join(temporary, "codemode");
    const sessions = join(cwd, "sessions");
    await mkdir(sessions, { recursive: true });
    const source = join(sessions, "source.jsonl");
    const script = [
      'const inspected = await tools.session_inspect({ view: "overview" });',
      "return JSON.stringify({",
      "  kind: typeof inspected,",
      "  session: inspected.history.sessionId,",
      "  handoff: typeof tools.session_handoff,",
      "  listed: ALL_TOOLS.map((tool) => tool.name).toSorted(),",
      "});",
    ].join("\n");
    const result = await exec(
      process.execPath,
      [
        cli,
        "--print",
        "--offline",
        "--no-extensions",
        "-e",
        "builtin:codemode",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--tools",
        "codemode,session_inspect,session_handoff",
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-luna",
        "--thinking",
        "low",
        "--session",
        source,
        "--session-dir",
        sessions,
        "-e",
        extension,
        "Call the codemode tool exactly once. Pass this JavaScript as its code argument, " +
          `unchanged:\n\n${script}\n\nThen reply with only the script's JSON output.`,
      ],
      { cwd, env, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.doesNotMatch(result.stderr, /Failed to load extension|Extension error|not a function/);
    const manager = SessionManager.open(source);
    const results = manager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
      );
    assert.deepEqual(
      results.map((message) => message.toolName),
      ["codemode"],
      "The model calls only codemode.",
    );
    const codemode = results[0];
    assert.ok(codemode);
    const text = codemode.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    assert.equal(codemode.isError, false, text);
    assert.deepEqual(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)), {
      kind: "object",
      session: manager.getSessionId(),
      handoff: "undefined",
      listed: ["session_inspect"],
    });
    t.diagnostic("Pi 0.99.1: live codemode script received structured session_inspect output.");
  },
);
