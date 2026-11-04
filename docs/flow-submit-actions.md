# Alternative final submission actions

Custom flows can offer two alternative final submission actions. Each action
validates the form, records its configured scalar values, and submits through
the existing feedback pipeline. Use this pattern when choosing an outcome and
committing the feedback should happen in one interaction. A choice field followed
by ordinary Submit remains appropriate when the choice needs separate review.

This is a general flow capability. Publication permission is one recipe, rather
than a built-in rating or testimonial policy.

## Independent capabilities

| Capability | Placement | Purpose |
| --- | --- | --- |
| `submitActions` | Final configured form screen | Record a choice and submit in one action. |
| `quotePreview` | Form screen | Display the first nonblank earlier text answer as a plain-text blockquote. |
| `prefillFromContext` | Short-text or long-text field | Supply an editable per-open default when the field is shown. |

None requires either of the others. The
[reply-preference example](../test/fixtures/reply-preference-flow.ts) uses actions
without a preview, defaults, rating, or publication permission. The
[publication-permission recipe](publication-permission-flow.md) composes all three.

## Action contract

Only the last configured screen, when it is a form, may declare `submitActions`.
That form still requires at least one field. Exactly two distinct nonempty labels
are supported, each with a scalar metadata map containing one to eight entries.
The first action receives the primary button treatment. Message and screenshot
screens cannot declare actions, and `continueLabel` cannot accompany them.

```ts
{
  id: 'feedback-screen',
  type: 'form',
  form: 'feedback',
  submitActions: [
    { label: 'Record reply requested', metadata: { 'reply-preference': 'reply' } },
    { label: 'Just send feedback', metadata: { 'reply-preference': 'no-reply' } },
  ],
}
```

Map those values into output explicitly, for example with an Issue section:

```ts
{ heading: 'Reply preference', context: 'reply-preference' }
```

Metadata is recorded only after successful validation. It overrides matching
opening-context values for submission without changing context used by routing.
Values without an Issue mapping are not automatically emitted as payload metadata.
Action labels and metadata are declarative configuration, not callbacks or
application policies. Recording a reply preference does not collect a contact
address or initiate a reply. Recording an anonymity preference does not remove
identity, screenshots, attachments, or other identifying evidence. Recording
publication permission does not publish anything or change repository visibility.
The application owns those behaviors.

The submission lock prevents duplicate or opposite clicks while busy. A retry
retains the selected values and validated answers, but may issue another request;
there is no server-side exactly-once guarantee after a lost response. Closing
before submission sends nothing. Flows without actions keep ordinary Submit.

## Text preview and editable defaults

`quotePreview` accepts one to three earlier text-answer paths. It displays the
first nonblank value as plain text, without HTML interpolation or another answer.
Blank values render no blockquote. This is a text quote preview, not a general
review component for ratings, choices, or evidence. Issue output remains governed
by its own mappings.

`prefillFromContext` names a declared opening-context key on a text field. The
default applies when the field renders without a saved answer. Edits, including
an explicit blank, take precedence. Non-string defaults are ignored and strings
respect the field's text limit. Existing hidden-answer cleanup still applies.

## Compatibility and release boundary

These are opt-in, unreleased source additions. Existing configurations need no
changes. New options require a supporting SDK; older pinned SDKs can reject them.
The default feedback journey is not changed into a choice-based flow.
Self-hosted `data-api-url` routing is a separate transport capability and does not
depend on any of these flow options.
