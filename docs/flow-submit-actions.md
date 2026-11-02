# Final-screen submit actions (unreleased)

Form screens may define two `submitActions` on the last configured screen. Both
buttons validate the current form and submit the existing flow once; neither is
a navigation or early-save operation. Close and Escape still abandon the draft.

```ts
{
  id: 'sharing', type: 'form', form: 'credit',
  quotePreview: ['quote.text', 'experience.comment'],
  submitActions: [
    { label: 'Yes, you can share this', metadata: { 'publication-permission': true } },
    { label: 'Keep my feedback private', metadata: { 'publication-permission': false } },
  ],
}
```

`metadata` contains 1–8 scalar values with valid context identifiers. The selected
action overrides matching open-context values only when compiling the final
Issue. Map keys using ordinary Issue context sections, such as
`{ heading: 'Publication permission', context: 'publication-permission' }`.
It does not change transport routing, screenshot consent, or normal answers.
Validation failures do not choose an action, duplicate clicks are guarded by the
existing submission lock, and retries preserve the selected metadata.

`quotePreview` displays the first nonempty earlier text answer, as plain text.
It accepts 1–3 answer paths and cannot reference the current or a later form.
It neither changes nor publishes that answer. Use Back to edit earlier answers.

Issue sections also support `when` conditions. This preserves Bleep's existing
answer-gated follow-up identity behavior without minified-runtime patches.
`data-api-url` on the script explicitly configures the API destination when the
widget is served from a pinned local asset; the script-host fallback remains.

This is an additive source change, not a released widget version. Existing
flows without these properties retain their original navigation and submission.

Text fields can declare `prefillFromContext: 'account-name'` to use a per-open
context value as an editable default. It is applied only when the field is
rendered. Hidden-field answers are still cleared, and a user-saved empty string
is preserved rather than refilled. Non-string defaults are ignored; strings are
bounded by the configured text limit. A default is not permission to publish.
