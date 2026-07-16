# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

For the `coding:wayfinder` skill. GitHub's `gh` CLI has no first-class issue-dependency or claim primitive, so express these with labels and a body convention.

- **Create the map**: `gh issue create --title "..." --label wayfinder:map`. Note its number `<M>`.
- **Create a ticket** (child of map `<M>`): `gh issue create --label "wayfinder:map-<M>,wayfinder:<type>"`, where `<type>` is `research`, `prototype`, `grilling`, or `task`. The `wayfinder:map-<M>` label is what makes it a child and drives the frontier query. Reference the map in the body so a reader can navigate up.
- **Blocking** (no native relationship): record it in the ticket body under a `## Blocked by` section listing the blockers as `- #<n>` task-list items. A ticket is unblocked when every issue it lists is closed.
- **Frontier query** (open, unblocked, unclaimed children): `gh issue list --label "wayfinder:map-<M>" --state open --json number,title,assignees,body`, then drop any ticket that has an assignee or whose `## Blocked by` refs are not all closed.
- **Claim a ticket**: `gh issue edit <n> --add-assignee @me` — do this *first*, before any work.
- **Resolve a ticket**: `gh issue comment <n> --body "<answer>"` then `gh issue close <n>`, and append the one-line context pointer to the map's `## Decisions so far`.

Create labels once with `gh label create wayfinder:map` etc. if they don't exist.
