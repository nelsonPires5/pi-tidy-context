# pi-tidy-context

A [Pi](https://pi.dev) package that keeps long sessions tidy: it watches context
usage and triggers a guided handoff *before* the window runs out, so state is
summarized and carried over instead of being lost to compaction.

## How it works

The package tracks context usage as a **threshold percent** of the model's
context window, shown together with the **estimated token count** (used /
total). When usage crosses the threshold, it prompts a tidy handoff: summarize
decisions, open questions, and next steps so a fresh session can pick up cleanly.

- Default threshold: **80%** of the context window (with the estimated token
  count displayed alongside the percent).
- The threshold is configurable; the token estimate is informational and does
  not change when the threshold percent changes.

## Install

From npm (recommended):

```bash
pi install pi-tidy-context
```

Pin a version with `pi install pi-tidy-context@X.Y.Z`. See the
[releases page](https://github.com/nelsonPires5/pi-tidy-context/releases) (or
[npm](https://www.npmjs.com/package/pi-tidy-context)) for available versions.
`pi list` shows the installed package; `pi remove pi-tidy-context` removes it.

Alternatively, install straight from git (no npm publish needed):

```bash
pi install git:github.com/nelsonPires5/pi-tidy-context@vX.Y.Z
```

## Usage

Set the handoff trigger from inside Pi. Two modes:

```text
/tidy-threshold 75    # percent mode: trigger at 75% of the context window
/tidy-threshold 150k   # tokens mode: trigger at ~150,000 tokens
```

- Percent mode accepts a bare integer `1`–`100`; tokens mode accepts `<n>k`
  (e.g. `150k`, `200k`). Anything else is rejected with a usage hint.
- Tab-completion offers the current value plus presets (`80`, `90`, `150k`,
  `200k`).
- The threshold persists to `~/.pi/agent/handoff.json` (overridable via
  `PI_HANDOFF_CONFIG_PATH`) and reloads on session start.
- Default: **80%** of the context window.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup (`bun install`,
`bun test`, `tsc --noEmit`), branch model, and release flow. User-facing
changes go in [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`.
