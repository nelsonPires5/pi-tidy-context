# Context Handoff Instructions

The current Pi context is approaching its limit. Create both files below with complete, verified information from this conversation.

Copy each absolute path exactly as shown. Do not insert line breaks, spaces, or word-wraps into the paths — write each quoted path as a single unbroken line.

- Handoff file `{{HANDOFF_FILENAME}}` — absolute path (quoted, in its own fenced block, single line, no line breaks):

```text
"{{HANDOFF_FILE}}"
```

- Next-session prompt `{{NEXT_PROMPT_FILENAME}}` — absolute path (quoted, in its own fenced block, single line, no line breaks):

```text
"{{NEXT_PROMPT_FILE}}"
```

The generated files must be written in the language the user has been using in this conversation. This template is in English for implementation consistency; do not force the output to English. Use the user's dominant/recent language (Portuguese, in a Portuguese conversation).

## Handoff file requirements

Write a self-contained handoff document containing:

1. **Original goal** — the user's request and success criteria.
2. **Constraints and preferences** — explicit requirements, conventions, and scope limits.
3. **Progress**
   - completed work;
   - current work;
   - unfinished work;
   - the exact stopping point.
4. **Files and changes** — every created, modified, deleted, or relevant file, with a concise description.
5. **Commands and verification** — important commands run, their results, tests run, and failures.
6. **Technical decisions** — decisions, alternatives considered, and rationale.
7. **Problems and blockers** — unresolved errors, assumptions, external dependencies, and risks.
8. **Next steps** — ordered, concrete actions with relevant paths, commands, functions, and expected results.
9. **Critical context** — branch/worktree, environment, configuration, paths, and facts that must not be lost.

Do not invent completed work. Distinguish verified facts from assumptions. Prefer precise details over generic summaries.

## Next-session prompt requirements

Write the next-session prompt file as a ready-to-send prompt for a fresh Pi context. It must instruct the next agent to:

1. Read the handoff file first.
2. Inspect the current repository state before changing anything.
3. Avoid repeating completed work.
4. Continue exactly from the recorded stopping point.
5. Execute the ordered next steps.
6. Run relevant validation and report failures honestly.

The prompt must be self-contained, actionable, and written in the user's conversation language.

## Final verification

Actually create both files, then verify that both exist and contain non-empty, useful content. Do not merely describe what should be written.
