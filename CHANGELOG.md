# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
