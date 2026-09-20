# Changelog

All notable changes are documented here using Keep a Changelog.

## Unreleased

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
