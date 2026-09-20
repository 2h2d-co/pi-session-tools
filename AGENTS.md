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
- Maintain `CHANGELOG.md` in Keep a Changelog style; keep entries under `Unreleased` for prereleases and move them into a release section only for stable releases.
- Use `npm run release -- <version>` to build the release package locally, create an SSH-signed `release: v<version>` commit containing its `Npm-Artifact-SHA256` trailer, verify a clean rebuild, and create the matching lightweight tag.
- Push the release commit and tag atomically; do not use `git tag -a`, `git tag -s`, `git tag -m`, or `cog bump --annotated`.
- Push stable or prerelease `v<version>` tags and let CI build and stage the package with trusted publishing and provenance, then create the immutable GitHub release from the verified archive and the version's changelog section. Never create GitHub releases by hand.
- Publication and installation into a user's live Pi configuration are separate operations.
