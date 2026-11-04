# Publication-permission recipe

This recipe composes the general
[alternative final submission actions](flow-submit-actions.md), earlier-text
preview, and editable context defaults. The rating threshold, publication scope,
and attribution copy are application decisions, not built-in flow policies.

The recipe shows a quote and editable credit on one final screen, with two buttons that choose
permission and submit the feedback. There is no separate permission selection or
extra Submit click. See the [executable example](../test/fixtures/publication-flow.ts).

1. Collect a rating and optional comment. Ratings one through four submit normally.
2. For five stars without a comment, offer an optional quote. A supplied quote
   must contain at least five characters; blank remains valid.
3. Show the quote and an editable display-name default. Blank credit means
   Anonymous. Either **Yes, you can share this** or **Keep my feedback private**
   validates this form, stores the corresponding metadata, and submits once.
4. Show the existing acknowledgement. No earlier screen creates an Issue.

The example maps `publication-permission` through an ordinary Issue context
section. Open it with a private default and a website-only channel:

```ts
const handle = window.BugDrop.registerFlow(publicationFlow);
const opened = handle.open({
  context: {
    'account-name': profile.displayName,
    'publication-permission': false,
    'publication-channels': 'website',
  },
});
```

Missing/false permission and an empty quote never authorize publication.
Permission covers the website only. Publication remains a separate manual
operation; this API does not automatically publish anything. The private button
still submits the quote and credit as feedback, without permission to feature it.
Do not infer publication permission from the presence of credit or a high rating.

## Capability decisions

| Capability | Decision | Reason |
| --- | --- | --- |
| `submitActions` | Retained | Choosing permission and submitting in one click is an explicit requirement. Existing choice fields plus ordinary Submit add an interaction. |
| `quotePreview` | Retained | The final screen must show an earlier quote beside editable credit. Existing form/message descriptions are static, and Back changes that experience. |
| `prefillFromContext` | Retained independently | Hidden initial answers are pruned; a conditional text field needs its editable per-open default when shown. |
| Conditional Issue sections | Omitted | Ordinary answer/context mappings and `omitWhenEmpty` are sufficient; existing conditional screens clean hidden answers. |
| `data-api-url` | Retained independently | Bleep serves its pinned widget asset locally but needs a separate feedback backend. Public flow open/register APIs do not configure transport. |

## Final submit actions

See the [general action contract](flow-submit-actions.md#action-contract) for
mapping, precedence, supported placement, and the distinction between recording
a choice and enforcing application behavior. Here the recorded choice is
publication permission.

Only the **last configured screen**, when it is a form, may declare
`submitActions`. It must contain exactly two distinct nonempty labels and scalar
metadata maps with one to eight entries. Action labels and metadata are
configuration, not executable callbacks. `continueLabel` cannot be combined with
these actions. Earlier screens continue using existing navigation.

```ts
{
  id: 'sharing-screen',
  type: 'form',
  form: 'sharing',
  when: { answer: 'experience.rating', equals: 5 },
  quotePreview: ['quote.text', 'experience.comment'],
  submitActions: [
    { label: 'Yes, you can share this', metadata: { 'publication-permission': true } },
    { label: 'Keep my feedback private', metadata: { 'publication-permission': false } },
  ],
}
```

The selected action is applied only after the form validates. Its metadata
supersedes matching per-open context keys **for submission**, without changing
context used for routing. The first accepted click locks submission; a second
or opposite click while busy cannot replace the selected action. A retry retains
that action and all validated form answers. Retries can issue another request;
this is not a server-side exactly-once guarantee after a lost response.
Closing before submission creates no Issue. Existing flows without actions
continue using ordinary Submit.

## Quote preview and conditional defaults

`quotePreview` accepts one to three earlier text-answer paths and displays the
first nonblank answer as a plain-text blockquote. It does not interpolate HTML,
collect another answer, or alter Issue content. Missing/blank values show no
blockquote. Existing conditional-screen primitives implement the optional quote
step; no new routing API is needed.

The attribution text field opts into `prefillFromContext: 'account-name'`.
Supply the account's display name; do not use an email/internal identifier as
public credit. Defaults apply only when the field renders and has no saved
answer. User edits, including an explicit empty string, take precedence.
Non-string defaults are ignored; strings respect the field's text limit.
Native hidden-answer cleanup removes abandoned quote/credit answers when the
rating changes to a route that hides those screens. Action metadata is not set
by visiting or leaving the sharing screen.

## Self-hosted API routing

Set `data-api-url="https://feedback.example/api"` on a self-hosted widget script
when its backend is elsewhere. Without a nonempty override, existing script-host
derivation remains unchanged. This is developer-owned configuration, not a
feedback answer or a value read from flow context.

These additions are unreleased source capabilities. Bleep PR #2689 still pins
the earlier candidate; updating its bundle and qualifying that integration is
separate from this SDK PR. This PR does not deploy a widget or Worker.

## Acceptance evidence

Native-manager tests exercise both permission buttons with one final request,
opposite/double-click suppression, validation before metadata, retry retention,
cancellation, one-to-four-star bypass, and hidden-answer cleanup. Desktop and
393 × 852 responsive Chromium cases exercise the quote boundary, same-screen
preview/credit/buttons, edited and anonymous credit on both choices, and visible
control bounds. Rating-only pointer/keyboard changes update routing labels.
