import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Value } from "typebox/value";
import { handoffText, prepareHandoff, verifyFindings } from "../src/handoff.ts";
import { handoffSchema, validateHandoff, type HandoffInput } from "../src/schemas.ts";

const inline: HandoffInput = {
  expectedSessionId: "session",
  mode: "new",
  handoff: { kind: "inline", text: "No schema changes. Implement the plan." },
};

test("mode and handoff field combinations are exclusive", () => {
  validateHandoff(inline);
  validateHandoff({ ...inline, mode: "compact", compactionInstructions: "Preserve tests" });
  validateHandoff({ ...inline, mode: "fork", targetEntryId: "checkpoint" });
  for (const input of [
    { ...inline, targetEntryId: "not-allowed" },
    { ...inline, mode: "navigate" },
    { ...inline, compactionInstructions: "not-allowed" },
    { ...inline, handoff: { kind: "inline", text: " " } },
    { ...inline, handoff: { kind: "inline", text: "ok", path: "bad" } },
    { ...inline, handoff: { kind: "file", path: "file" } },
    { ...inline, handoff: { kind: "file", path: "file", instruction: "read", text: "bad" } },
  ] satisfies HandoffInput[]) {
    assert.throws(() => validateHandoff(input));
  }
  assert.equal(Value.Check(handoffSchema, { ...inline, unknown: true }), false);
  assert.equal(
    Value.Check(handoffSchema, {
      ...inline,
      handoff: { kind: "inline", text: "x".repeat(16001) },
    }),
    false,
  );
});

test("file handoffs hash findings but never embed the file contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-tools-files-"));
  await writeFile(join(dir, "findings.md"), "Evidence that must not be copied into a handoff");
  const prepared = await prepareHandoff(
    {
      ...inline,
      handoff: { kind: "file", path: "@findings.md", instruction: "Read then implement" },
    },
    dir,
  );
  assert.match(prepared.text, /Read then implement/);
  assert.doesNotMatch(prepared.text, /Evidence that/);
  assert.equal(
    prepared.file?.path,
    await import("node:fs/promises").then((fs) => fs.realpath(join(dir, "findings.md"))),
  );
  await verifyFindings(prepared);
  await writeFile(join(dir, "findings.md"), "Changed findings");
  await assert.rejects(verifyFindings(prepared), /changed after/);
});

test("missing files, directories, and aborted file checks fail before a handoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-tools-invalid-"));
  const input: HandoffInput = {
    ...inline,
    handoff: { kind: "file", path: "missing.md", instruction: "Read" },
  };
  await assert.rejects(prepareHandoff(input, dir));
  await assert.rejects(
    prepareHandoff({ ...input, handoff: { ...input.handoff, path: dir } }, dir),
    /regular file/,
  );
  await assert.rejects(prepareHandoff(input, dir, AbortSignal.abort()));
});

test("symlink resolution is stable and inline text preserves current restrictions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-tools-link-"));
  await writeFile(join(dir, "findings.md"), "Findings");
  await symlink("findings.md", join(dir, "link.md"));
  const prepared = await prepareHandoff(
    {
      ...inline,
      handoff: { kind: "file", path: "link.md", instruction: "Read" },
    },
    dir,
  );
  assert.ok(prepared.file?.path.endsWith("findings.md"));
  const text = handoffText(await prepareHandoff(inline, dir), {
    sessionId: "origin",
    entryId: "checkpoint",
    sessionFile: "/sessions/origin.jsonl",
  });
  assert.match(text, /No schema changes/);
  assert.match(text, /not restored or isolated/);
  assert.match(text, /session=origin entry=checkpoint/);
  assert.match(text, /does not grant new permission/);
});

test(
  "findings FIFOs are rejected without waiting for a writer",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-session-tools-fifo-"));
    const filename = join(dir, "findings");
    await promisify(execFile)("mkfifo", [filename]);
    await assert.rejects(
      prepareHandoff(
        {
          ...inline,
          handoff: { kind: "file", path: filename, instruction: "Read" },
        },
        dir,
      ),
      /regular file/,
    );
  },
);
