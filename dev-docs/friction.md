# Friction log

Things that cost time while working in this repo - layout, tooling, setup. Each
entry says what it cost and what would fix it, so this reads as an inbox rather
than a diary.

Claude: append here when something slows you down and the fix isn't yours to
make in passing. One entry per annoyance, with a proposed fix - if you can't
name a fix, it's probably an observation, not friction. Keep it to the project
and its tooling.

Triage: promote real items to beads (`bd create`) and delete them from here once
filed. Length should mean unresolved friction, not history.

---

*Empty. Last triage 2026-08-21: the manual smoke list shipped as
dev-docs/manual-smoke.md (`meditation-pal-nx1d`, closed). Earlier triage
2026-08-05: session.ts size (`meditation-pal-e89d`), phone-dev cheatsheet section
(`meditation-pal-75p1`), recognizer event fixtures (`meditation-pal-x11x`).*

- **bd git hook does not stage `.beads/interactions.jsonl`** (bd 1.2.2, hook shim 1.1.2 and the fresh `bd hooks install` alike): the pre-commit hook stages `beads.jsonl`/`issues.jsonl`/`deletions.jsonl` only, so every bd close/update leaves interactions.jsonl dirty after an agent session. Patched locally on 2026-09-06 by adding it to the loop in `.git/hooks/pre-commit`; upstream beads should add it. Re-apply after any `bd hooks install`.
