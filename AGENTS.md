# Pi session tools

- This package exposes `session_inspect` and `session_handoff`.
- Support Pi 0.86.0 and later. Keep Pi peer ranges open-ended from that minimum
  and pin development dependencies to the version actually tested.
- Test system instructions and tool declarations at the provider boundary.
  Replacement continuations must enter Pi's normal prompt preparation path.
- Use the public Pi extension API. Do not mutate session JSONL or runtime internals.
- Navigation accepts complete assistant/tool-batch boundaries, not arbitrary messages.
- Keep inspection bounded and read-only. Never include thinking blocks.
- Preserve source history. Never restore workspace files or automatically replay uncertain handoffs.
- Keep handoff messages separate from summarizer instructions.
- Run `mise run check` before committing. Use `mise run fmt` for formatting.
- Behavioral tests use Node's built-in test runner and Pi's real session manager.
- Keep `.github/npm-package-files` aligned with the packed files.
- Maintain `CHANGELOG.md` under `Unreleased` until a separately authorized release.
- Publication and installation into a user's live Pi configuration are separate operations.
