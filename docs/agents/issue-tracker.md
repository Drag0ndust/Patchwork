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

For the `coding:wayfinder` skill. GitHub has **native sub-issues** (parent/child) and **native issue dependencies** (blocked-by) — use these, **not** labels or body conventions, for map membership and blocking. Both are driven through `gh api`; the `sub_issue_id` / `issue_id` params take the issue's **database id** (`gh api repos/{owner}/{repo}/issues/<n> --jq .id`), not its number.

- **Create the map**: `gh issue create --title "..." --label wayfinder:map`. Note its number `<M>`.
- **Create a ticket**: `gh issue create --label "wayfinder:<type>"`, where `<type>` is `research`, `prototype`, `grilling`, or `task`. Then attach it as a **sub-issue** of the map (below). Reference the map in the body so a reader can navigate up.
- **Attach as sub-issue** (child of map `<M>`): `gh api --method POST repos/{owner}/{repo}/issues/<M>/sub_issues -F sub_issue_id=<child-db-id>`. This native parent/child link is what makes it a map ticket and renders the tree in GitHub's UI.
- **Blocking** (native): `gh api --method POST repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Remove with the matching `DELETE .../dependencies/blocked_by/<blocker-db-id>`. A ticket's live block count is `.issue_dependencies_summary.blocked_by` (open blockers only); `total_blocked_by` counts closed ones too.
- **Frontier query** (open, unblocked, unclaimed children): `gh api repos/{owner}/{repo}/issues/<M>/sub_issues --jq '.[] | select(.state=="open") | {number,title,assignee:.assignee.login,blocked:.issue_dependencies_summary.blocked_by}'`, then drop any ticket with an assignee or `blocked > 0`.
- **Claim a ticket**: `gh issue edit <n> --add-assignee @me` — do this *first*, before any work.
- **Resolve a ticket**: `gh issue comment <n> --body "<answer>"` then `gh issue close <n>`, and append the one-line context pointer to the map's `## Decisions so far`.

Create labels once with `gh label create wayfinder:map` etc. if they don't exist.
