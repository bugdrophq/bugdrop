# Issue #300: Form Prefill Implementation Plan

**Status:** Implemented; pending PR review

**Date:** 2026-09-30

**Base:** `origin/main` at `d60d857` in the fresh `codex/issue-300-prefill-plan` worktree

**Issue:** https://github.com/bugdrophq/bugdrop/issues/300

## Goal

Let a host application suggest a submitter nickname, optionally an email address, and a different
starting description for each built-in category (`bug`, `feature`, `question`). The reporter can
review and edit every value before submitting. These values are convenience defaults, not proof of
identity.

## Current contract and constraints

- The built-in form shows name and email only when `data-show-name` / `data-show-email` or their
  corresponding required flags are enabled. Its `initialValues` argument restores a prior form
  after screenshot capture; a new opening begins with empty values.
- `window.BugDrop.open()` currently takes no options. The established v1 compatibility contract
  explicitly says extra arguments, including arbitrary objects and DOM events, are ignored. Do
  not repurpose those arguments for prefilling. Keep `open()` synchronous and safe to use directly
  as an event listener.
- The floating trigger and `open()` must share the same prefill behavior. The fixed and private
  default-flow runtimes must produce the same result. Registered variants and custom flows have
  their own initial-answer contracts and are outside this change.
- The host app knows its user's nickname or email. BugDrop must not infer either from browser,
  GitHub, cookies, or token claims. An optional existing auth-token gate authorizes a submission
  for a repository; it does not verify the `submitter` name or email in the feedback payload.
- Name and email are written into the GitHub Issue body if submitted. Anyone with access to that
  repository's Issues may read them; Issues in a public repository are public.

## Public integration contract

Add one opt-in `data-prefill-provider` attribute containing the name of a host-owned global
function, following the existing `data-auth-token-provider` pattern. Resolve and call the function
when the built-in details form opens, after any welcome screen. Its synchronous return value is:

```ts
interface BugDropPrefill {
  name?: string;
  email?: string;
  descriptionTemplates?: Partial<Record<'bug' | 'feature' | 'question', string>>;
}
type BugDropPrefillProvider = () => BugDropPrefill | null | undefined;
```

Example for a host app (the callback can read a current in-memory session on every opening):

```html
<script>
  window.getBugDropPrefill = () => ({
    name: window.appSession?.user?.nickname,
    // Include email only if the host app wants to offer it for submission.
    email: window.appSession?.user?.email,
    descriptionTemplates: {
      bug: 'What happened?\nSteps to reproduce:\nExpected result:',
      feature: 'What would you like to see?\nWhy would it help?',
      question: 'What would you like to know?\nWhat have you tried?',
    },
  });
</script>
<script src="https://bugdrop.example/widget.js"
        data-repo="owner/repo"
        data-show-name="true"
        data-show-email="true"
        data-prefill-provider="getBugDropPrefill"></script>
```

The example URL is illustrative, not a new endpoint. The attribute carries only a function name;
do not put personal data in the script tag, a URL, or local storage. A non-function, thrown error,
or invalid value yields an empty default for that field and a diagnostic that contains no supplied
personal data. Do not let a bad provider prevent the form from opening. The provider is synchronous
for this version; apps with asynchronous profile loading can update their own session state before
the form is opened. Document this limit explicitly.

Keep `name` and `email` optional. A supplied value does not turn a hidden field on; the existing
show/require flags control visibility. Do not auto-enable or require email, and do not collect it by
default. Render a short note by a visible prefilled email explaining that it will be included in
the GitHub Issue; the user may edit or clear it. Do not describe either field as verified.

## Description behavior

1. On a new form, select the built-in `bug` category and insert its template if provided.
2. Until the user edits the description, a category change replaces the untouched template with
   the new category's template (or an empty string when none exists).
3. After any user edit, including clearing the textarea, category changes never overwrite it.
   The form does not need per-category draft storage for this first version.
4. Returning from screenshot capture restores the prior category, name, email, description,
   attachments, and other form state. It must not call the provider again or reapply a template.
5. Closing and opening a new form calls the provider again, so account changes take effect.

Assign values through safe DOM properties or the existing HTML-escaping path. The template is
literal editable textarea content, not HTML or an executable template language. Bound provider
string lengths before rendering and do not log the values. Keep limits generous enough for useful
question prompts; define exact constants and error behavior in tests and documentation.

## Implementation sequence

### 1. Lock down the contract with tests

- Add unit tests for provider lookup, permitted types, missing/throwing providers, hidden fields,
  and returned object normalization.
- Add a browser test that passes an object or click event to legacy `BugDrop.open()` and confirms
  arguments are still ignored. Preserve the v1 protocol and legacy-compatibility fixtures.
- Add a focused form test for untouched category switching, edits, clearing, and screenshot return.

### 2. Add the provider seam to the default widget

- Add a small provider resolver and a typed, bounded prefill snapshot in `src/widget/`, parsed from
  `data-prefill-provider` in `src/widget/index.ts`.
- Call it once for each new built-in details form. Pass the snapshot into the form renderer without
  changing `BugDrop.open()`'s signature or the submission payload format.
- Wire both default-flow runtimes through the same helper and preserve the existing previous-form
  state on screenshot return. Avoid invoking the provider for variants or custom flows.

### 3. Render and preserve the defaults

- Populate only visible name/email controls, and populate the description for the selected
  category. Add a user-edit flag for description changes and update the template on category
  changes only while untouched.
- Ensure an absent provider retains today's empty form and does not add work on load. Keep title,
  screenshot, attachments, console-log behavior, and submission unchanged.
- Show the prefilled-email disclosure with accessible text. Keep it accurate for public and
  private repositories without claiming the issue is private.

### 4. Harden submitter rendering at the Worker boundary

- Treat all incoming `submitter` values as untrusted, regardless of provider use or auth token.
  Validate types and bounded lengths server-side; reject line breaks, control characters, and
  bidirectional formatting controls in name
  and email, and validate email syntax without an overly narrow provider-specific rule.
- Escape name/email for their inline GitHub Markdown position. Today `formatIssueBody()` inserts
  them directly, so a crafted value can change the apparent Issue body. Preserve ordinary names
  and addresses. Test malicious Markdown, headings, links, and newline attempts through the API.
- This changes acceptance of malformed legacy submissions. State that explicitly in the change
  notes and verify representative existing valid payloads still create the expected Issue body.
  Do not treat provider values or token `sub` as verified identity.

The normative v1 contract's item 8 has a narrow Issue #300 safety exception: malformed or
overlong submitter name/email values can receive a 400 response before Issue creation, and
accepted Markdown-sensitive values are escaped in the inline submitter position. Ordinary valid
legacy strings retain their exact Issue-body output, response, and payload shape. This does not
change `BugDrop.open()` arguments or make submitted identity verified.

### 5. Document the integration and privacy boundary

- Update `docs/website/configuration.mdx`, `docs/website/javascript-api.mdx`, and security/FAQ
  guidance with the callback contract, category semantics, sync-only behavior, and examples for
  apps with a current-user object.
- State plainly: the host supplies defaults; the reporter can alter them; BugDrop does not verify
  ownership of the nickname or email. A self-hosted auth-token gate can restrict submissions but
  does not bind the submitted identity fields to the token. Email is included in the GitHub Issue
  only when the field is shown and retained by the reporter.
- Keep authenticated/verified attribution as a separate future design requiring a server-derived
  identity binding. Do not add a `verified` label or claim in this feature.

### 6. Verify and review before a PR

- Run focused unit/API tests, `npm run typecheck`, `npm run lint`, and the legacy compatibility
  tests. Build the widget before E2E. Run relevant Playwright E2E for trigger and API openings,
  both default-flow runtimes, category changes, screenshots, and form reopening.
- Use a realistic adversarial test: set a nickname containing Markdown control characters and
  switch category after typing an answer. Prove that the Issue body cannot be visually spoofed and
  the answer is preserved. Also prove an absent provider produces the current behavior.
- Before a PR, follow the repository's review-agent gate. Before merge, run
  `codex-pr-review-toolkit:review-pull-request` against the base and address findings. Report the
  exact tested commit and any unverified environment-specific behavior.

## Acceptance criteria

- A host app can supply a fresh nickname, optional email, and three category templates through one
  documented callback for the built-in floating trigger and `BugDrop.open()`.
- No existing integration needs to change; `open()` arguments remain ignored and an absent or
  broken provider opens the original empty form.
- Category changes never erase reporter-authored description text; screenshot return retains all
  entered values; a later new form reads the current host-app user.
- A prefilled email is visible, editable, clearable, and described as Issue content. No personal
  values are stored in URLs, script attributes, local storage, or logs by this feature.
- The server treats name/email as unverified input and renders them safely in the GitHub Issue.
- Tests demonstrate both the useful path and the strongest failure cases; documentation makes no
  identity-verification claim.
