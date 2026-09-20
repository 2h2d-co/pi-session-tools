import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { HandoffInput } from "./schemas.ts";

export interface FindingsFile {
  requestedPath: string;
  path: string;
  sha256: string;
}

export interface PreparedHandoff {
  text: string;
  file?: FindingsFile;
}

/** Hash a regular file without loading or exposing its contents. */
async function fingerprint(requestedPath: string, signal?: AbortSignal): Promise<FindingsFile> {
  signal?.throwIfAborted();
  const path = await realpath(requestedPath);
  // Nonblocking open lets us reject FIFOs before waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("Findings path must be a regular file.");
    const hash = createHash("sha256");
    const stream = file.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) });
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected findings file stream encoding.");
      hash.update(chunk);
    }
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Findings file changed while it was being checked.");
    }
    return { requestedPath, path, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

export async function prepareHandoff(
  input: HandoffInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<PreparedHandoff> {
  if (input.handoff.kind === "inline") {
    return { text: input.handoff.text ?? "" };
  }
  const rawPath = input.handoff.path ?? "";
  const requestedPath = resolve(cwd, rawPath.startsWith("@") ? rawPath.slice(1) : rawPath);
  const file = await fingerprint(requestedPath, signal);
  return {
    text: `Read the findings file ${JSON.stringify(file.path)} before proceeding.\n\n${input.handoff.instruction ?? ""}`,
    file,
  };
}

export async function verifyFindings(prepared: PreparedHandoff): Promise<void> {
  if (!prepared.file) return;
  const current = await fingerprint(prepared.file.requestedPath);
  if (current.path !== prepared.file.path || current.sha256 !== prepared.file.sha256) {
    throw new Error("Findings file changed after the handoff was prepared. Prepare a new handoff.");
  }
}

export interface Origin {
  sessionId: string;
  entryId: string;
  sessionFile?: string;
}

export function handoffText(prepared: PreparedHandoff, origin: Origin): string {
  return [
    "[Agent-authored session handoff]",
    `Source checkpoint: session=${origin.sessionId} entry=${origin.entryId}`,
    ...(origin.sessionFile ? [`Source session file: ${JSON.stringify(origin.sessionFile)}`] : []),
    "Only conversation context changed. Files, commits, remote effects, and running processes were not restored or isolated.",
    "This handoff does not grant new permission. Preserve the user's current restrictions and verify the workspace before editing.",
    "",
    prepared.text,
  ].join("\n");
}
