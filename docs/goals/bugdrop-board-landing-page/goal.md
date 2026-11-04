# BugDrop Board Landing Page

Build the first BugDrop Board marketing landing page on `bugdrop.dev`, using the completed
BugDrop Board customization/gallery work as source material.

## Original Request

> ok plan this out with goalbuddy prep and lets do it

## Outcome

`bugdrop.dev` has a `/board` landing page that clearly introduces BugDrop Board as the embedded,
self-hostable feedback board companion to BugDrop. The page should show the Board value proposition,
explain the GitHub-backed/self-host model at a high level, display the custom UX gallery examples,
and give interested users a clear next step without changing production credentials, deploys, or
BugDrop Board product behavior.

## Goal Oracle

The goal is complete only when a reviewer can run the BugDrop site locally and visit `/board` to see
a polished, responsive landing page that includes:

- a clear BugDrop Board product headline and positioning;
- a section explaining embedded install, signed host tokens, GitHub-backed issues, upvotes, and
  self-hosting;
- the custom UX gallery sourced from the BugDrop Board screenshots;
- links or calls to action to the Board repo/docs and existing BugDrop surfaces;
- mobile and desktop visual proof that the page renders without broken images, overlap, or layout
  drift.

## Success Criteria

- `/board` routes correctly in the existing BugDrop site architecture.
- Gallery assets from `/Users/neonwatty/Desktop/bugdrop-board/docs/marketing/assets` are copied or
  otherwise made available to the BugDrop site with stable public paths.
- The page uses the existing BugDrop site stack, styling patterns, and build tooling.
- The page does not imply a hosted control plane, billing, realtime transport, comments, downvotes,
  GitHub Projects, package publish, or production deploy.
- Copy is honest about the current beta/self-host model.
- Local verification includes repo gates plus browser or Playwright screenshots for desktop and
  mobile.
- Final handoff includes a burden-of-proof check that tries to disprove the gallery rendering.

## Non-Goals

- Cloudflare deploy.
- DNS changes.
- Secret or credential changes.
- Hosted control plane.
- Billing.
- Realtime updates.
- Comments or downvotes.
- GitHub Projects.
- Changes to the BugDrop Board Worker/API/widget package.
- Publishing a new npm package.

## Starter Command

`/goal Follow docs/goals/bugdrop-board-landing-page/goal.md.`

