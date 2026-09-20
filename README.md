# pi-session-tools

Pi extension for inspecting conversation checkpoints and handing work to a
different conversation context.

- **`session_inspect`** finds or reads checkpoints across the current session tree.
- **`session_handoff`** navigates, forks, compacts, or starts a fresh session,
  then appends a handoff and resumes the agent.

A checkpoint is the last message of a completed assistant response and its tool
batch. A handoff carries findings, current restrictions, and next steps. This
extension does not launch subagents or restore workspace files.

## Requirements and loading

Tested with Pi **0.85.1** and Node.js **22.23.2**. The package requires Pi
`>=0.85.1 <0.86.0` and Node.js `>=22.19.0`.

From this checkout:

```sh
mise run install
mise exec -- pi -e ./extensions/index.ts
```

This does not change your Pi configuration. Keep other extensions enabled,
including any required provider or system-prompt extensions.

The npm package name is **`@2h2d/pi-session-tools`**. It is not yet published.
After a release, installation will be:

```sh
pi install npm:@2h2d/pi-session-tools
```

## Automatic checkpoints

The extension records a checkpoint after each valid `turn_end`. Pi defines a
turn as one assistant response plus all its tool results, not the entire user
request. A checkpoint can therefore mark the boundary before a lengthy
investigation within a single request.

The agent receives compact metadata at those boundaries:

```text
[Session checkpoint: session=<session-id> entry=<entry-id>]
```

Use these IDs directly. There is no need to query history before every handoff.
The source checkpoint is included in the destination handoff for a direct
return. Other branches and compacted-away checkpoints remain discoverable
through `session_inspect`.

Checkpoint IDs are persisted as extension entries. Markers are inserted into
model context without modifying the stored assistant messages. This preserves
Pi's text-mode final response and does not trigger additional model requests.
If another extension rewrites a message before context projection, its marker
may be omitted. The checkpoint remains available through inspection.

Pi's portable extension API represents these as custom metadata messages,
not developer-role messages. Static tool guidance explains their meaning.

## `session_inspect`

```ts
{
  view: "overview" | "ancestors" | "children" | "search" | "read";
  entryId?: string;
  query?: string;
  limit?: number;              // Default 20, maximum 50
  before?: number;             // Read view: default 2, maximum 10
  after?: number;              // Read view: default 2, maximum 10
  includeToolResults?: boolean; // Default false
  cursor?: string;
}
```

- `overview` lists completed-turn checkpoints across the full current tree.
- `ancestors` lists checkpoints on the path to `entryId`, or the active entry.
- `children` lists the next checkpoints on each path from the selected checkpoint.
- `search` matches literal, case-insensitive text in labels, assistant text,
  the latest user request, and optional tool results. It requires `query`.
- `read` inspects an entry and nearby context. It requires `entryId`.
  At a branch point, it lists child IDs instead of silently choosing a path.

Responses include the current session and entry IDs, checkpoint relationships,
labels, previews, approximate context token counts, and recent operation phases.
Token counts estimate serialized message characters divided by four. They are
not provider usage measurements.

Repeat the same arguments with `nextCursor` as `cursor` to continue a page.
Pagination uses a fixed snapshot even when subsequent turns add entries.
Reading returns up to 8,000 text characters per page. Total output is capped at
48,000 bytes. Reduce page or neighbor limits if the output reports truncation.
Thinking blocks, image data, and tool-call arguments are never returned.
Tool output is opt-in and can contain sensitive source material.

Inspection does not navigate or search other session files.

## `session_handoff`

Every call includes the current `expectedSessionId` and one handoff:

```ts
{
  expectedSessionId: string;
  mode: "navigate" | "fork" | "compact" | "new";
  targetEntryId?: string;
  compactionInstructions?: string;
  handoff:
    | { kind: "inline"; text: string }
    | { kind: "file"; path: string; instruction: string };
}
```

| Mode       | Destination     | Retained conversation                     |
| ---------- | --------------- | ----------------------------------------- |
| `navigate` | Current session | Path through `targetEntryId`              |
| `fork`     | New session     | Copy of the path through `targetEntryId`  |
| `compact`  | Current session | Pi's summary and retained recent messages |
| `new`      | New session     | No inherited conversation                 |

`targetEntryId` is required only for `navigate` and `fork`. It must identify a
complete turn. The selected entry is retained. Mid-batch tool results, unmatched
tool calls, user messages, and arbitrary metadata entries are rejected.

`compactionInstructions` is allowed only for `compact`. It guides the summarizer.
It is **not** the post-compaction handoff.

### Inline handoff

```json
{
  "expectedSessionId": "<current-session-id>",
  "mode": "compact",
  "compactionInstructions": "Preserve the agreed design and validation results.",
  "handoff": {
    "kind": "inline",
    "text": "Investigation complete. Retries duplicate writes. No files changed. Add request deduplication and concurrency tests. Do not change the database schema."
  }
}
```

Inline text is limited to 16,000 characters. It is appended verbatim inside an
agent-authored wrapper with source information and workspace safety reminders.

### Findings-file handoff

```json
{
  "expectedSessionId": "<current-session-id>",
  "mode": "new",
  "handoff": {
    "kind": "file",
    "path": "research/findings.md",
    "instruction": "Read this file first, then implement its recommended approach."
  }
}
```

Relative paths resolve against the source working directory. A leading `@` is
accepted. The file must already exist and be a regular readable file.
The extension resolves symlinks and hashes the file without embedding its
contents. It checks the path and hash again before moving and before delivery.
A detected change stops the handoff. The file remains mutable after delivery.

### Execution and recovery

Call `session_handoff` **alone**, after other tools and findings-file writes
finish. The initial result says **accepted**, not completed.

1. Validate the request, destination, and absence of pending user input.
2. Record the request and terminate the tool batch.
3. At `agent_settled`, dispatch an internal command and wait for it.
4. Navigate, fork, compact, or create the new session through Pi's public APIs.
5. Append exactly one handoff after success and start the next agent run.

The command completion is joined by the settled event so Pi's print and JSON
hosts do not exit before the handoff completes. Forks and new sessions use Pi's
fresh replacement context. Continuation starts after the host finishes its
replacement action, so a late editor reset cannot erase a new draft.
Compaction waits for its completion callback.

Incoming user input, unsubmitted editor drafts, session changes, failed validation, or cancellation from
another extension stop a pending handoff. Already-completed context changes are
not silently undone. Source history remains available.

Operation records use unique IDs. Reloading or resuming a session never replays
unfinished requests automatically. Inspect the current context and source
history before requesting a replacement operation. Navigation, message append,
and generation are not one atomic transaction. A crash or generation failure
can leave the destination selected without a completed continuation.

The internal `/session-tools-apply-handoff` command accepts only a matching
in-memory request. It is not a recovery or manual-navigation command.

## Safety boundaries

- Files, Git commits, remote side effects, and running processes are unchanged.
- A fork is not a filesystem sandbox.
- A new session loads normal system and project instructions in the same
  working directory. It does not inherit the old conversation.
- Fork and new-session modes require a persisted session so the original can
  be resumed. Navigation and compaction also work with in-memory sessions.
- Carry current user restrictions, changed paths, validation results, active
  process handles, remaining work, and next steps in the handoff or findings file.
- Agent-authored handoffs do not grant new permissions.
- Other extensions retain their own lifecycle and side effects. Review any
  extension that restores files during navigation.

## Development

```sh
mise run install
mise run test
mise run check
mise run fmt
```

Tests load the extension through Pi's real resource loader and use an offline
scripted provider. They exercise tree boundaries, compaction, fresh runtime
replacement, cancellation, input races, restart recovery, and actual print/JSON
hosts. No real provider requests or live user sessions are needed.

`.github/npm-package-files` defines the expected npm package contents. CI checks
types, formatting, lint, repository hygiene, secrets, workflows, tests,
dependency audit, and package contents.

Publishing to npm, configuring trusted publishing, changing repository
protections, and installing into a user's live Pi configuration are separate,
explicitly authorized operations.
