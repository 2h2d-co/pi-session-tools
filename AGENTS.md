# Pi session tools

- This package exposes `session_inspect`, `session_handoff`, and the `/handoff` command.
- `/handoff` serves users and the extension. Its `apply <operation-id>` form applies
  only the agent request pending in memory. User handoffs keep every safety check agent
  handoffs have. Keep the user-facing name `/handoff`. Find this extension's copy by its
  description, because Pi renames duplicate commands to `handoff:N`.
- Support Pi `>=1.2.0 <1.3.0`. Keep Pi peer ranges bounded below the next Pi
  minor release and pin development dependencies to the version actually
  tested. Do not keep fallbacks for Pi versions below the minimum.
- Test system instructions and tool declarations at the provider boundary.
  Replacement continuations must enter Pi's normal prompt preparation path.
- Use the public Pi extension API. Do not mutate session JSONL or runtime internals.
- Navigation accepts complete assistant/tool-batch boundaries, not arbitrary messages.
- Keep inspection bounded and read-only. Never include thinking blocks.
- Preserve source history. Never restore workspace files or automatically replay uncertain handoffs.
- Keep handoff messages separate from summarizer instructions.
- Run `mise run check` before committing. Use `npm run fmt` for formatting.
- Behavioral tests use Node's built-in test runner and Pi's real session manager.
- Keep `.github/npm-package-files` aligned with the packed files.
- Maintain `CHANGELOG.md` in Keep a Changelog style; keep entries under `Unreleased` for prereleases and move them into a release section only for stable releases.
- Use `npm run release -- <version>` to build the release package locally, create an SSH-signed `release: v<version>` commit containing its `Npm-Artifact-SHA256` trailer, verify a clean rebuild, and create the matching lightweight tag.
- Push the release commit and tag atomically; do not use `git tag -a`, `git tag -s`, `git tag -m`, or `cog bump --annotated`.
- Push stable or prerelease `v<version>` tags and let CI build and stage the package with trusted publishing and provenance, then create the immutable GitHub release from the verified archive and the version's changelog section. Never create GitHub releases by hand.
- Publication and installation into a user's live Pi configuration are separate operations.
- Live tests report every error they meet as a test diagnostic, even when they pass: extension error and warning notices, extension errors, and failed responses. Use `test/support/error-log.ts`. Summarize failed responses by stop reason, HTTP status, and error category; never print provider error text or credentials.
- Keep tests in `test/*.test.ts`, code that tests import or load into Pi in `test/support/`, and test data in `test/fixtures/`.
