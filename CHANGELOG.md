# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-25

### Added

- Handoff status on the themed Working line (`tidy-context: preparing handoff
  files` / `writing handoff files` / `will compact on settle` / `sending next
  prompt`), cleared before compaction, on errors, and on the next
  `turn_start`; `notify` stays as the chat fallback for non-TUI modes.
- `keepRecentTokens` guard: `/tidy-threshold` rejects thresholds at or below
  Pi's effective `keepRecentTokens` (global + project settings merged,
  per-model `compaction.modelOverrides` honored) with an error and does not
  save them, so the handoff no longer refires in a loop right after each
  compaction.

### Fixed

- Defer compaction until the agent settles: when files verify while a run is
  still active, the handoff now waits (`pending-compact`) and compacts from
  `agent_settled`, avoiding `Error: This operation was aborted` from calling
  `compact()` mid-run.
- Silent wait for handoff files: intermediate `turn_end`s no longer spam the
  missing-files error while the model is still writing; the final error is
  emitted from `agent_settled` only, at most once per handoff cycle.

## [0.1.3] - 2026-10-25

### Added

- Automatic npm publishing: the Release workflow now publishes the exact
  tagged commit to npm (`npm publish` with provenance via Trusted Publisher
  OIDC), so `pi install pi-tidy-context` works alongside git installs.
- Release runbook: documented the bot-PR workflow-approval step (`action_required`
  runs must be approved before checks report), so future releases follow it.

## [0.1.2] - 2026-10-25

### Changed

- Renamed the command `/handoff-threshold` to `/tidy-threshold` (old name removed).

## [0.1.1] - 2026-10-25

### Added

- Initial package scaffold (Pi package manifest, docs, CI/release workflows).
