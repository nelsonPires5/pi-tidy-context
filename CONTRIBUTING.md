# Contributing

Thanks for your interest in pi-tidy-context! Bug reports, feature requests, and
pull requests are welcome.

## Development setup

Requirements: [Bun](https://bun.sh) (latest stable).

```bash
git clone https://github.com/nelsonPires5/pi-tidy-context
cd pi-tidy-context
git checkout dev        # all feature work happens on dev, never on main
bun install
bun test              # run the test suite
bunx tsc --noEmit     # typecheck (same commands CI runs)
```

This is a [Pi package](https://pi.dev/packages): `package.json` carries the
`pi-package` keyword and Pi discovers extensions, skills, prompts, and themes
from the conventional directories (`extensions/`, `skills/`, `prompts/`,
`themes/`). It is installed straight from git — no npm publish step:

```bash
pi install git:github.com/nelsonPires5/pi-tidy-context@vX.Y.Z
```

## Branch model

| Branch           | Role                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `dev`            | Long-lived integration branch. **All feature work targets `dev`.**      |
| `main`           | Production, the default branch. **Only the Release workflow tags from `main`.** |
| `release/vX.Y.Z` | Cut by the Prepare Release workflow; PRs against `dev` (or `main` for hotfixes). |

- Work on `dev`: create feature branches from `dev` and open PRs against `dev`.
- **PR-only: no direct pushes to `main`.** Every change to `main` arrives via a
  pull request merged with a **merge commit** (no squash/rebase), so CI runs on
  the merge and the Release workflow can tag the exact green commit.
- Only hotfixes open PRs against `main` directly; everything else goes through
  the `dev -> main` promotion PR opened by the Promote workflow.
- **Releases only via workflow.** Never create, move, or delete `v*` tags by
  hand — the Release workflow owns them.

## Gates that must pass

Keep these green before opening a PR (they are the same commands CI runs):

- `bun test`
- `bunx tsc --noEmit`

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/): `feat: …`,
`fix: …`, `docs: …`, `test: …`, `chore(release): …` (the last one is written by
automation — don't use it by hand).

## PR expectations

- One focused change per PR. Update `README.md` and `CHANGELOG.md`
  (`[Unreleased]`) in the same PR as a user-facing change — a change isn't done
  until the docs match it.
- Feature PRs open against **`dev`**; only hotfixes open against **`main`**.
- The gates above pass.

## Release policy

Releases follow the Prepare Release → promote → tag flow (modeled on
herdr-board, simplified for this small TS repo):

1. A maintainer dispatches **Prepare Release** with `patch`/`minor`/`major`
   (base `dev`; `main` only for hotfixes). It bumps `package.json`, adds the
   `CHANGELOG.md` section, runs the gates, and cuts `release/vX.Y.Z` plus its
   PR against the base.
2. The release PR merges into `dev`. The **Promote** workflow then opens the
   `dev -> main` PR; a maintainer merges it with a merge commit. CI runs on the
   merge (an automated merge would silently skip CI, so a human merges).
3. The **Release** workflow consumes the green `main` CI run, sees the version
   bump in `package.json` versus the merge's first parent, and creates the
   annotated tag `vX.Y.Z` plus the GitHub Release at that exact commit.
4. After promotion, `main` is merged back into `dev` so `dev` keeps the history.
