# BugDrop Board Guided Demo Polish

## Objective

Make the production BugDrop Board demo at `/board-dogfood` feel like a smooth,
obvious embedded feedback board inside a believable customer app.

## Original Request

> Use three independent UX sub-agents to examine this screenshot looking for ways
> to improve the UX, making a smoother user experience and introduction to the
> feedback board with any kind of highlighting, elaboration, simplifications
> necessary. Then I want you to make a goal buddy prep board to make those
> suggested changes, ship them, and then double check the shipped results in
> production and show me a new screenshot when you're done.

## Goal Oracle

A desktop and mobile production walkthrough proves that a first-time viewer can
understand the embedded app context, the purpose of the feedback board, the
kanban lifecycle, and the upvote action without internal dogfood framing,
ambiguous vote labels, noisy metadata, broken layout, or hidden primary actions.

## Acceptance Criteria

- Three independent UX critiques are captured and synthesized.
- The demo host uses believable customer-app framing instead of internal console
  framing.
- The board introduction is brief, visible, and explains add/vote/status flow
  without turning into a tutorial.
- Kanban lane headers, counts, cards, and voting controls are easier to scan.
- Upvote counts remain visible and accessible.
- Existing signed-token, GitHub-backed, upvote-only product behavior is
  preserved.
- Focused unit tests and repo validation gates pass for changed code.
- Pull requests are opened, CI is monitored, and changes are merged when green.
- Production is checked after deploy with DOM assertions and desktop/mobile
  screenshots.

## Constraints

- No hosted control plane, billing, realtime, comments, downvotes, GitHub
  Projects, package publishing, version bump, credential changes, or destructive
  dogfood cleanup.
- Keep changes scoped to demo UX, widget presentation ergonomics, tests, and this
  GoalBuddy record.
- Use existing repo stacks and release paths.

## Run Command

```text
/goal Follow docs/goals/bugdrop-board-guided-demo-polish/goal.md.
```
