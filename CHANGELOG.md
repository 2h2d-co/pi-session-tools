# Changelog

All notable changes are documented here using Keep a Changelog.

## Unreleased

### Added

- `session_inspect` declares an output schema and returns structured content, so scripts run by
  Pi's `codemode` tool receive the full page as an object. It is annotated read-only and
  closed-world.
- `session_handoff` is annotated as non-destructive and closed-world.

### Changed

- `session_handoff` is `model-only`. `codemode` scripts no longer see or call it, because a call
  from a script could never pass its sole-call check.
- Require Pi 0.99.1 or later. The reduced mode for Pi versions before 0.87.0 is removed.

## 0.0.4 - 2026-09-30

### Changed

- Validate releases against Pi 0.99.1. Pi 0.87.0 and newer remain supported.

## 0.0.3 - 2026-09-23

### Fixed

- On a Pi older than 0.87.0, the session-start notice names the disabled features:
  checkpoint markers and `session_handoff`. Checkpoint recording and `session_inspect`
  remain available there.

## 0.0.2 - 2026-09-22

### Changed

- Require Pi 0.87.0 or later and validate against Pi 0.87.0. Older runtimes report an
  error at session start and refuse handoffs.
- Project checkpoint markers through Pi's `context_with_system` event so mid-conversation
  prompt and tool updates stay in place instead of being folded into the leading system
  message on every request.

### Fixed

- Handoffs no longer hang on Pi 0.87, which defers prompts sent from `agent_settled`
  handlers until they return. The settled handler dispatches the internal command without
  waiting for it; Pi runs the command before it resolves idle waits.

## 0.0.1 - 2026-09-20

### Added

- Automatic turn-boundary checkpoints with bounded history inspection.
- Context handoffs through navigation, forks, compaction, and new sessions.

### Changed

- Require Pi 0.86.0 or later and validate against Pi 0.86.0.
- Show system instruction changes and tool names in history inspection.

### Fixed

- Prepare system and project instructions before the first response in a
  replacement session. Respect its input handlers and prompt/tool changes.
- Reject system-message interruptions inside incomplete tool batches.
