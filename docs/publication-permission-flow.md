# Publication permission with existing flow primitives

Publication permission does not require a new submission API. Use the executable
[example configuration](../test/fixtures/publication-flow.ts):

1. Collect the rating and optional blurb in an ordinary form.
2. Show a required `singleChoice` permission field only for exactly five stars.
   There is no initial selection: `yes` and `no` are distinct stored strings.
3. Show the attribution form only when the choice equals `yes`.
4. Let the normal final-screen **Submit** create the one feedback Issue.
   A private choice submits from the choice screen; a public choice continues to
   attribution and submits there. Selecting an option does not submit anything.

The Issue maps the permission answer directly. Missing permission (including
ratings below five), `no`, and an empty quote never authorize publication.
The example's permission covers the website only. Publication remains a separate
manual operation. Closing abandons the draft without submitting it.

Attribution uses `omitWhenEmpty: true`. Existing hidden-answer cleanup removes
its value when Back → No hides that form, and when a lower rating hides the
sharing route. This also handles optional attribution without conditional Issue
sections. The rating/comment form remains the place to review or edit the quote;
Back returns to it. No separate read-only quote-preview API is needed.

## Capability decisions for PR #463

| Capability | Decision | Existing alternative or remaining gap |
| --- | --- | --- |
| `submitActions` | Removed | A required `singleChoice`, conditional attribution, and ordinary Submit collect permission with one Issue. One-click choose-and-submit is not a requirement of this revision. |
| `prefillFromContext` | Retained independently | `initialAnswers` seeds are pruned when their conditional screen is initially hidden. Existing text fields have no per-open default applied when the field becomes visible. This preserves an editable account-name default without weakening hidden-answer cleanup. |
| `quotePreview` | Removed | Review/edit the existing text form using Back. Rendering an extra read-only copy is optional presentation, not required for permission collection. |
| Conditional Issue sections | Removed | Map the conditional attribution answer and use existing `omitWhenEmpty`; hidden-answer cleanup removes abandoned attribution. This example does not conditionally include private identity context. Other context-gating requirements need separate evaluation. |
| `data-api-url` | Retained independently | A pinned/self-hosted script otherwise derives the backend from its asset host/path. Public `registerFlow` and `open` do not accept transport endpoints. This script-level override addresses asset hosting, not publication permission. |

## Conditional text defaults (unreleased)

The example's attribution field opts into `prefillFromContext: 'account-name'`.
Omit this optional property to use the permission composition without that new
capability. Supply only a display name you intend the user to review:

```ts
const handle = window.BugDrop.registerFlow(publicationFlow);
const opened = handle.open({ context: { 'account-name': profile.displayName } });
```

The default is applied only when that field renders and has no saved answer.
User edits, including an explicit empty string for Anonymous, take precedence.
Non-string defaults are ignored; string defaults respect the field's text limit.
A default is not publication permission. Do not seed a hidden attribution answer
and bypass its cleanup, or use an email/internal account ID as a public name.

## Self-hosted API routing (unreleased)

Set `data-api-url="https://feedback.example/api"` on a self-hosted widget script
when its backend is elsewhere. Without a nonempty override, the existing
script-host derivation remains unchanged. This is developer-owned configuration,
not a value read from feedback answers or flow context.

Both retained additions are unreleased. This PR does not deploy a widget or
update Bleep's pinned integration. Bleep PR #2689 still uses the earlier
one-click candidate and must be adapted and repinned separately before rollout.
