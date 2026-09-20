import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./print-fixture.ts", import.meta.url));

for (const output of ["text", "json"]) {
  for (const mode of ["navigate", "fork", "compact", "new"]) {
    test(`Pi ${output} host waits for ${mode} and preserves the final response`, async () => {
      const { stdout, stderr } = await exec(process.execPath, [fixture, mode, output], {
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.match(stdout, /print-handoff-completed/);
      assert.doesNotMatch(stderr, /Extension error|Failed|Error:/);
      if (output === "text") assert.equal(stdout.trim(), "print-handoff-completed");
    });
  }
}
