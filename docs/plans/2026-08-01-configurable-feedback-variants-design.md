# Configurable Feedback Variants

**Status:** Proposed; Phase 0 prerequisite complete

**Date:** 2026-08-01

**Scope:** Additive extension to the BugDrop v1 widget and Worker contracts

## Summary

Extend BugDrop from one fixed feedback wizard into a small declarative feedback system that can
render multiple independently configured UX variants on the same page. Every submission that
BugDrop reports as successful creates a GitHub Issue through the existing Worker and GitHub App.

The current widget remains the default and is not redesigned by this work. Existing script tags,
data attributes, `window.BugDrop` methods, request payloads, GitHub Issue formatting, storage, and
screenshot flows remain unchanged when no variant API is used.

The initial proving variants are:

1. A one-to-five-star review with an optional message and explicit Submit button.
2. A CTA-driven question that opens a simple text-response form.
3. A single-choice poll with an optional explanation.
4. A compact suggestion form with a short summary and optional detail.

These are acceptance fixtures, not the architectural limit. Contributors can compose additional
variants from shared primitives or use the headless submission API with host-rendered UI.

## Phase 0 Baseline

The merge-queue real-Issue canary was implemented and proven before variant work began. PR #258 and
merge-group run `30724180366` demonstrated the following existing contract:

- The tested `widget.js` bytes match the merge-group checkout.
- Preview health and the actual `/api/feedback` response identify the merge-group Worker SHA.
- Preview deployment and all preview consumers run under the `bugdrop-shared-preview` lock.
- The deployed legacy widget makes one screenshot-free submission with Playwright retries disabled.
- The existing GitHub App creates one real Issue.
- A server-side verifier independently checks the Issue number, URL, title, body, labels, author,
  attribution, system information, marker, and absence of a screenshot.
- Cleanup closes every Issue matching the run marker and proves no reserved-prefix canary Issue
  remains open.
- Pull-request, local, production, scheduled, manual, and ordinary live paths cannot select the
  mutating browser canary.

The operational contract is documented in
[`docs/merge-queue-issue-canary.md`](../merge-queue-issue-canary.md). Variant work reuses this
critical section, identity proof, verifier, token boundary, and cleanup model. It must not create a
second independent canary system.

## Problem

BugDrop currently owns one hard-coded flow:

1. Optional welcome screen.
2. Bug, feature, or question category selection.
3. Required title and optional description.
4. Optional submitter information and evidence.
5. Optional screenshot capture and annotation.
6. GitHub Issue creation.

This flow is valuable and must remain stable, but it is too opinionated for contextual prompts such
as post-action reviews, embedded polls, or a targeted “Which provider should we add?” CTA. Host
applications can build those experiences themselves, but they must then duplicate BugDrop's auth,
metadata, transport, error handling, and GitHub submission behavior.

Loading multiple copies of the current widget is not a safe workaround. The bundle discovers one
script element, creates one `#bugdrop-host`, stores legacy state in module globals, and assigns one
`window.BugDrop` object.

## Goals

- Preserve the complete legacy widget contract by default.
- Load the BugDrop bundle once and support multiple logical variant instances.
- Provide declarative modal and inline presentations.
- Provide a small field catalog that can grow without changing the Worker protocol.
- Keep one explicit Submit action per response.
- Create one GitHub Issue for every submission that BugDrop reports as successful.
- Support configurable copy, validation, success states, and safe Issue templates.
- Keep raw GitHub label authority on the Worker.
- Provide a headless API for host-rendered experiences.
- Publish usable JavaScript and TypeScript integration contracts.
- Make built-in fields and presentations straightforward for contributors to add and test.
- Require no new database, queue, storage product, or backend service.

## Non-goals

- Replacing or visually redesigning the existing BugDrop wizard.
- Refactoring the legacy wizard behind a new runtime or controller in the first release.
- A hosted visual form builder or remote configuration service.
- Response aggregation, dashboards, surveys, or analytics storage.
- Conditional branching or multi-page form logic in the first release.
- Screenshot, attachment, or console-log evidence for variants in the first release.
- A public runtime plugin API that executes third-party renderer code inside BugDrop's Shadow DOM.
- Dynamic variant lookup, unregistration, or public analytics events in the first release.
- A strict exactly-once delivery guarantee during GitHub or network outages.
- Supporting multiple copies of `widget.js` on one page.

## Terminology

- **Legacy widget:** The current BugDrop trigger, wizard, evidence flow, and payload.
- **Variant:** A named declarative form definition.
- **Variant handle:** The durable object returned when a variant is registered.
- **Instance:** One mounted inline form or one opened modal created from a variant.
- **Presentation:** The container and interaction model, initially `modal` or `inline`.
- **Field controller:** The internal renderer-owned DOM and lifecycle controller for one field.
- **Headless submission:** A host-rendered UI calling BugDrop for metadata, auth, and submission.
- **Issue template:** Browser-side declarative rules that produce a bounded Issue draft.
- **Issue draft:** A field-agnostic title and ordered list of generic sections sent to the Worker.

## Design Decisions

### One script, one legacy widget, many variant instances

The page loads one BugDrop script. The existing widget remains the only legacy instance. A lazy
sidecar manager owns variant definitions and isolated instance state.

Multiple script tags remain unsupported. Multiple logical variant instances are supported.

### Sidecar before refactor

The first release does not introduce a `BugDropRuntime`, legacy adapter, or
`LegacyWidgetController`. It leaves `openFeedbackFlow()` and legacy module globals structurally
intact. Only two shared seams may be extracted when tests prove them equivalent:

1. Authenticated JSON transport and metadata collection.
2. Pure generic Issue-draft validation and formatting for structured submissions.

This keeps the largest compatibility risk out of the initial implementation.

### Composition over named special cases

`rating-review` is not a permanent hard-coded branch. It combines a rating field, an optional long
text field, a presentation, and an Issue template. New combinations do not require Worker changes.

### Rendering is separate from submission

BugDrop-rendered and host-rendered forms produce the same normalized Issue draft. The Worker does
not need to know whether BugDrop, React, or another host renderer produced it.

### The browser controls UX; the Worker controls GitHub policy

Browser configuration controls copy, field order, client validation, and Issue-draft composition.
The Worker treats all of it as untrusted, enforces generic limits, renders bounded Markdown,
appends mandatory attribution and system information, resolves raw labels, and creates the Issue.

### Compatibility is executable

Legacy behavior is protected by historical fixtures and candidate-Worker tests, not only by
documentation or by rerunning tests generated from the new implementation.

## Backwards-Compatibility Contract

The following behavior is normative:

1. A page using only the existing script tag receives the existing widget.
2. All existing `data-*` attributes retain their current defaults and meanings.
3. `window.BugDrop.open(...ignoredArguments)` always opens the legacy form and skips the welcome
   screen. Extra arguments—including DOM events, strings matching variant IDs, `null`, and arbitrary
   objects—remain ignored. Variants open only through a returned `VariantHandle`.
4. Existing API methods remain synchronous, context-independent closure functions with the same
   return values. Destructuring a method or passing it directly as an event callback remains valid.
5. `close()`, `hide()`, `show()`, `isOpen()`, `isButtonVisible()`, and `setTheme()` remain scoped to
   the legacy widget and retain their current behavior and signatures.
6. `bugdrop:ready` fires exactly once as a non-bubbling, non-cancelable `CustomEvent` on `window`,
   after the final additive API object is installed. Its `detail` remains `null`.
7. The existing `#bugdrop-host` remains the legacy host and is not renamed.
8. Existing `FeedbackPayload` requests remain valid and retain their current validation, response,
   Issue body, label, and error behavior.
9. Existing localStorage keys, values, scoping, and screenshot behavior are unchanged for the
   legacy flow.
10. Variant-only CSS, DOM, storage, and payload fields are namespaced and inert until a variant API
    is called.
11. Existing `widget.v1.js` consumers receive additive behavior only. Any unavoidable incompatible
    change requires `widget.v2.js`.
12. Variant-only capabilities are feature-detected lazily. A browser that can run the current
    widget must not fail legacy startup because a variant-only global is unavailable.

**Issue #300 narrow submitter safety exception to item 8.** The existing feedback request shape,
`BugDrop.open()` argument behavior, successful response, and exact Issue-body bytes for ordinary
valid legacy name/email strings remain unchanged. The Worker now rejects malformed `submitter`
name/email types, overlong values, line breaks/control or bidirectional formatting characters, and malformed email addresses
before Issue creation. Accepted name/email strings that contain Markdown or HTML control text are
escaped only in the inline `Submitted by` position, so they cannot forge Issue structure. These
two changes are limited to submitter validation and safe rendering for both direct API and widget
requests. Such input was previously accepted or interpolated verbatim; the changed rejection or
rendering is an explicit security exception to item 8 and is not a new widget API.

Record the v1.53.1 minified and gzip bundle sizes before implementation. The first release may not
increase compressed `widget.js` by more than 25% without a separately reviewed exception. A
legacy-only bootstrap test removes variant-only globals, asserts no variant DOM/listeners/UUID work,
and records initialization timing so a material startup regression cannot hide behind functional
tests.

Before implementation changes the legacy submission path, check in reviewed goldens captured from
at least one tag-reconstructed v1 bundle and the current v1 tag. Each fixture records its source
commit, lockfile hash, deterministic build command, output hash, and an explicit disclaimer that it
is not claimed to be byte-identical to historically deployed CDN bytes. The baseline covers
bootstrap, API methods, detached calls, event timing, normalized request payloads, Issue formatting
and labels, semantic DOM, storage, and screenshot-free and evidence-bearing flows. Candidate Workers
must accept these legacy requests. Exact old-version CDN retention is a separate, pre-existing
release-policy concern and is not silently broadened by this phase.

The reserved variant ID `legacy` cannot be registered by a caller.

## Modal Arbitration

Legacy semantics win over the additive sidecar:

| Existing state | Requested action | Required result |
| --- | --- | --- |
| No modal | Open variant | Open the variant modal |
| Legacy modal active | Open variant | Return a documented `busy` outcome; do not alter legacy DOM or state |
| Variant modal active | Open another variant | Close the first through its cancellation controller, then open the second |
| Variant modal active | Call legacy `BugDrop.open()` | Close the variant through its controller, then open the legacy flow |
| Variant modal active | Call legacy `BugDrop.close()` | Preserve legacy-scoped no-op behavior; do not close the variant |

Removing DOM is not a cancellation primitive. Every variant modal owns an explicit controller that
settles its result exactly once and restores focus. Variant code must never remove a legacy wizard
or interfere with an awaited legacy screenshot or annotation step.

## Public Browser API

The first release adds one method to the existing object:

```ts
interface BugDropAPI {
  // Existing API, unchanged
  open(): void;
  close(): void;
  hide(): void;
  show(): void;
  isOpen(): boolean;
  isButtonVisible(): boolean;
  setTheme(mode: 'light' | 'dark' | 'auto'): void;

  // Additive variant API
  registerVariant(config: VariantConfig): VariantHandle;
}

interface VariantHandle {
  readonly id: string;
  open(options?: VariantOpenOptions): OpenedVariant;
  mount(target: HTMLElement, options?: VariantMountOptions): MountedVariant;
  submit(
    answers: Record<string, unknown>,
    options?: HeadlessSubmitOptions
  ): Promise<SubmissionResult>;
}

interface OpenedVariant {
  readonly instanceId: string;
  readonly result: Promise<VariantOutcome>;
  close(): void;
}

interface MountedVariant {
  readonly instanceId: string;
  reset(): void;
  unmount(): void;
}

interface VariantOpenOptions {
  context?: Record<string, string | number | boolean | null>;
  initialAnswers?: Record<string, unknown>;
}

type VariantMountOptions = VariantOpenOptions;

interface HeadlessSubmitOptions {
  context?: Record<string, string | number | boolean | null>;
  submissionId?: string;
}

type VariantOutcome =
  | { status: 'submitted'; result: SubmissionResult }
  | { status: 'closed' }
  | { status: 'busy' };

interface SubmissionResult {
  issueNumber: number;
  issueUrl: string;
  isPublic: boolean;
  labelMappingWarnings?: string[];
}
```

Registration validates the complete configuration synchronously and stores an immutable normalized
copy. Duplicate or reserved IDs, unknown field types, invalid templates, or duplicate field IDs
throw before any partial registration occurs. Later mutation of the caller's object cannot alter
an active instance or its submission.

`getVariant()`, `unregisterVariant()`, public renderer registration, and public variant lifecycle
events are deferred until real integrations demonstrate a need. A successful registration returns
a durable handle, which is sufficient for the initial CTA, mount, and headless use cases.

The repository must publish the public types as a supported `.d.ts` entry. Script-tag JavaScript
after `bugdrop:ready` and TypeScript consumers using that declaration are both supported integration
modes; the interfaces must not remain documentation-only pseudocode.

## Variant Configuration

```ts
interface VariantConfig {
  id: string;
  configVersion?: 1;
  presentation: VariantPresentation;
  appearance?: {
    theme?: 'light' | 'dark' | 'auto';
    accentColor?: string;
    density?: 'compact' | 'comfortable';
  };
  content: {
    title: string;
    description?: string;
    submitLabel?: string;
    cancelLabel?: string;
    successTitle?: string;
    successMessage?: string;
  };
  fields: VariantField[];
  issue: VariantIssueTemplate;
}

type VariantPresentation =
  | {
      kind: 'modal';
      size?: 'compact' | 'default' | 'wide';
      columns?: 1 | 2;
    }
  | {
      kind: 'inline';
      columns?: 1 | 2;
    };
```

Variant IDs and field IDs match `[a-z][a-z0-9_-]{0,63}`. Caller-provided content is literal display
copy. Built-in validation, loading, retry, accessibility, and fallback strings continue to come
from the active locale dictionary.

`open()` is valid for modal configurations and `mount()` for inline configurations; using the
opposite method throws a synchronous, descriptive presentation error. Headless `submit()` is valid
for either. Appearance defaults to the script configuration captured at registration. The legacy
`setTheme()` method remains legacy-scoped; a variant that needs a distinct theme supplies explicit
appearance when it is first registered. Runtime variant-theme mutation is deferred.

Evidence is unavailable for structured variants in the first release. Headless submission never
silently opens BugDrop UI. Screenshot, attachment, and console-log support requires a later API that
distinguishes caller-supplied evidence from a BugDrop-owned capture flow.

### Initial field catalog

```ts
type VariantField =
  | ShortTextField
  | LongTextField
  | RatingField
  | SingleChoiceField;

interface BaseField {
  id: string;
  label: string;
  helpText?: string;
  required?: boolean;
  layout?: { span?: 1 | 2 };
}

interface ShortTextField extends BaseField {
  type: 'shortText';
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
}

interface LongTextField extends BaseField {
  type: 'longText';
  placeholder?: string;
  rows?: number;
  minLength?: number;
  maxLength?: number;
}

interface RatingField extends BaseField {
  type: 'rating';
  scale?: 5 | 10;
  icon?: 'star' | 'number';
  lowLabel?: string;
  highLabel?: string;
}

interface SingleChoiceField extends BaseField {
  type: 'singleChoice';
  options: Array<{ value: string; label: string; description?: string }>;
  display?: 'radio' | 'cards' | 'buttons';
}
```

Answer values are keyed by field ID. Hidden application state is passed as bounded `context`, not
represented as a hidden field. New field types can be added without changing the Worker protocol
because the browser converts answers into generic Issue sections before transport.

## Issue Templates and Label Policy

Issue templates are declarative rather than executable callbacks:

```ts
interface VariantIssueTemplate {
  classification?: 'bug' | 'feature' | 'question' | 'feedback';
  title: string;
  sections?: Array<
    | {
        heading: string;
        field: string;
        format?: 'text' | 'quote' | 'stars' | 'choice';
        omitWhenEmpty?: boolean;
      }
    | {
        heading: string;
        context: string;
        format?: 'text' | 'code';
        omitWhenEmpty?: boolean;
      }
  >;
}
```

Title templates allow only `{{field-id}}` and `{{context.key}}`. IDs and keys follow their normal
syntax; there are no expressions, loops, conditionals, function calls, or nested object access.
Missing placeholders resolve to an empty string, whitespace is collapsed, and the final title is
bounded to 256 characters.

The browser validates answers and compiles the template into an Issue draft. `stars` becomes a
bounded textual rating and `choice` resolves the stored value to its configured display label.
The Worker never receives field definitions, option catalogs, or the complete context object. Only
context values explicitly referenced by an Issue section become section values in the draft.

The browser sends `variantId` and an optional classification but no `labelSet` or raw label array.
The Worker resolves optional custom labels by `{repo, variantId}` through `VARIANT_LABELS`:

```json
{
  "owner/repo": {
    "export-review": ["feedback", "rating"],
    "cloud-provider-question": ["enhancement", "cloud-import"]
  }
}
```

This follows the existing per-repository `CATEGORY_LABELS` configuration model and introduces no
configuration service. Unknown variants fall back to classification defaults plus `bugdrop` and
produce an operator warning. A payload containing raw `labels` or `labelSet` is rejected before a
GitHub call.

The mapping is classification, not authorization: a modified public client can claim another known
variant ID. Operators must not attach security-sensitive automation to a variant label alone. A
future privileged mapping would also need to bind allowed variant IDs to verified auth-token claims.

| Classification | Default labels |
| --- | --- |
| `bug` | `bug`, `bugdrop` |
| `feature` | `enhancement`, `bugdrop` |
| `question` | `question`, `bugdrop` |
| `feedback` or omitted | `bugdrop` |

## Initial Acceptance Variants

These examples are documentation snippets and automated fixtures. The runtime treats them as
ordinary configurations rather than named core branches.

### 1. One-to-five-star review

```ts
const review = BugDrop.registerVariant({
  id: 'export-review',
  presentation: { kind: 'inline' },
  content: {
    title: 'How was this export?',
    submitLabel: 'Submit review',
    successTitle: 'Thanks for the review!',
  },
  fields: [
    {
      id: 'rating',
      type: 'rating',
      label: 'Rating',
      required: true,
      scale: 5,
      icon: 'star',
    },
    {
      id: 'message',
      type: 'longText',
      label: 'Anything else?',
      maxLength: 1000,
    },
  ],
  issue: {
    classification: 'feedback',
    title: '[Export review] {{rating}}/5',
    sections: [
      { heading: 'Rating', field: 'rating', format: 'stars' },
      { heading: 'Comment', field: 'message', omitWhenEmpty: true },
    ],
  },
});

review.mount(document.querySelector('#export-review-slot')!);
```

Selecting a star changes local state only. One Issue is created only after the explicit Submit
button is activated.

### 2. CTA-driven question

The host owns CTA placement and calls the returned handle:

```ts
const providerQuestion = BugDrop.registerVariant({
  id: 'cloud-provider-question',
  presentation: { kind: 'modal', size: 'compact' },
  content: {
    title: 'Which cloud provider should we support next?',
    description: 'Tell us what would fit your workflow.',
    submitLabel: 'Send idea',
  },
  fields: [
    {
      id: 'response',
      type: 'longText',
      label: 'Your answer',
      required: true,
      minLength: 2,
      maxLength: 1000,
    },
  ],
  issue: {
    classification: 'feature',
    title: 'Cloud provider request — {{response}}',
    sections: [{ heading: 'Requested provider or workflow', field: 'response' }],
  },
});

button.addEventListener('click', () => {
  providerQuestion.open({ context: { surface: 'studio-upload' } });
});
```

Long responses are truncated only in the generated title, not the Issue section.

### 3. Single-choice poll

```ts
BugDrop.registerVariant({
  id: 'next-integration-poll',
  presentation: { kind: 'inline' },
  content: {
    title: 'What should we build next?',
    submitLabel: 'Vote',
  },
  fields: [
    {
      id: 'choice',
      type: 'singleChoice',
      label: 'Choose one',
      required: true,
      display: 'cards',
      options: [
        { value: 'onedrive', label: 'OneDrive' },
        { value: 'box', label: 'Box' },
        { value: 'other', label: 'Something else' },
      ],
    },
    {
      id: 'detail',
      type: 'longText',
      label: 'Optional detail',
      maxLength: 500,
    },
  ],
  issue: {
    classification: 'feature',
    title: 'Integration vote — {{choice}}',
    sections: [
      { heading: 'Choice', field: 'choice', format: 'choice' },
      { heading: 'Detail', field: 'detail', omitWhenEmpty: true },
    ],
  },
});
```

Conditional display when `other` is selected is deferred; the detail field remains visible and
optional so the first release does not introduce a rules engine.

### 4. Compact suggestion

```ts
BugDrop.registerVariant({
  id: 'compact-suggestion',
  presentation: { kind: 'modal', size: 'default' },
  content: {
    title: 'Share an idea',
    submitLabel: 'Submit idea',
  },
  fields: [
    {
      id: 'summary',
      type: 'shortText',
      label: 'Idea',
      required: true,
      maxLength: 120,
    },
    {
      id: 'detail',
      type: 'longText',
      label: 'How would this help?',
      maxLength: 2000,
    },
  ],
  issue: {
    classification: 'feature',
    title: '[Idea] {{summary}}',
    sections: [
      { heading: 'Idea', field: 'summary' },
      { heading: 'Why it would help', field: 'detail', omitWhenEmpty: true },
    ],
  },
});
```

## Structured Submission Contract

The Worker accepts the unchanged legacy payload and a collision-resistant structured payload:

```ts
interface StructuredFeedbackPayload {
  kind: 'bugdrop.variant-submission';
  schemaVersion: 1;
  repo: string;
  variantId: string;
  submissionId: string;
  issue: {
    title: string;
    classification?: 'bug' | 'feature' | 'question' | 'feedback';
    sections: Array<{
      heading: string;
      value: string;
      format?: 'text' | 'quote' | 'code';
    }>;
  };
  metadata: FeedbackMetadata;
}
```

The Worker selects the structured handler only when both `kind` and `schemaVersion` match. An
arbitrary legacy caller that already sends a `schemaVersion` property remains on the legacy path.
A matching `kind` with an unsupported version returns `400` without calling GitHub.

The structured payload is deliberately field-agnostic. The untrusted browser cannot make its own
validation rules authoritative by resending a field schema. The Worker validates only transport,
security, Markdown rendering, metadata, label policy, and size constraints.

Initial limits:

- At most 20 Issue sections.
- At most 64 characters for `variantId` and 120 characters per heading.
- At most 256 characters for the normalized title.
- At most 5,000 characters per section value.
- At most 32 KB for the complete structured payload.
- No screenshot, attachment, annotation, or console-log properties.

Duplicate or empty headings, nested values, non-finite numbers, control characters in identifiers,
unknown top-level policy fields, raw labels, invalid metadata, or an unsupported version return
`400` before GitHub is called. The Worker renders generic formats safely and always appends system
information, attribution, and the submission marker.

## Sidecar and DOM Architecture

Suggested source organization:

```text
src/widget/variants/
  public-types.ts
  validate-config.ts
  manager.ts
  submission.ts
  issue-draft.ts
  presentations/
    modal.ts
    inline.ts
  fields/
    index.ts
    short-text.ts
    long-text.ts
    rating.ts
    single-choice.ts

src/routes/
  structured-feedback.ts
```

The sidecar manager initializes lazily when `registerVariant()` is first called. It does not create
variant hosts, UUIDs, observers, listeners, or storage during a legacy-only bootstrap.

`mount(target)` appends one BugDrop-owned child host to `target`; it does not convert or replace the
target. Inline and modal hosts carry both:

```html
data-bugdrop-owned
data-bugdrop-instance="<instance-id>"
```

A shared `isBugDropOwnedNode()` predicate is used by screenshot capture, element picking, masking,
and host-compatibility code. All BugDrop-owned hosts are excluded from legacy capture and cannot be
selected as legacy evidence. Capture modes that cannot exclude DOM nodes directly temporarily hide
all owned hosts and restore them in `finally`.

Radix compatibility remains one runtime-level listener backed by a live set of owned roots. Mounting
two variants must not install duplicate global listeners or call `stopImmediatePropagation()` for
unrelated host content.

Each field renderer returns a controller rather than requiring later DOM rediscovery:

```ts
interface FieldController {
  element: HTMLElement;
  getValue(): unknown;
  setValue(value: unknown): void;
  focus(): void;
  dispose(): void;
}
```

Normalization and validation remain pure field-descriptor functions. A contributor adding a field
adds one union member, renderer/controller, conformance fixture, focused tests, and documentation;
the Worker formatter does not change.

## Validation and Accessibility

- Configuration errors are reported synchronously at registration.
- Answer validation runs only on Submit and focuses the first invalid field.
- Required state and errors use `aria-describedby` and `aria-invalid`.
- Rating controls expose native or equivalent radiogroup semantics. Arrow keys move selection and
  Enter/Space select without submitting.
- Single-choice cards and buttons preserve radio semantics.
- Variant modal presentation implements a new accessible shell with `role="dialog"`, an accessible
  name, `aria-modal`, Escape handling, focus containment, focus restoration, and background scroll
  locking.
- The new shell initially serves variants only. Migrating the legacy modal is a separate
  compatibility-proven change; the current legacy modal does not supply these primitives.
- Inline mounts do not move focus.
- Loading disables duplicate Submit activation and is announced through an ARIA live region.
- Pointer targets are at least 44 by 44 CSS pixels.
- Repeated mount/unmount and modal open/close dispose listeners and controllers.
- Stable semantic selectors use roles, accessible names, and namespaced `data-bugdrop-field`
  attributes rather than private CSS classes.

## Submission Lifecycle and Reliability

1. A form state creates one `submissionId`.
2. Validation failures retain that ID and do not call the Worker.
3. Submit disables the form, builds the normalized Issue draft, and requests auth through the
   existing provider.
4. The Worker validates auth, the structured envelope, generic sections, metadata, and label policy.
5. The Worker creates the GitHub Issue through the existing GitHub App.
6. BugDrop reports success only after receiving a positive Issue number and canonical Issue URL.
7. Transport retries for the same response reuse the same `submissionId`.
8. After success, a mounted form cannot submit again until `reset()`; reset creates a new ID.

The Issue contains:

```html
<!-- bugdrop-submission: <submissionId> -->
```

The marker supports forensics and best-effort duplicate detection. Without new durable storage,
network loss after GitHub accepts an Issue can still race a retry; exactly-once delivery is not
promised.

Variant and legacy submissions share the existing IP and repository rate-limit buckets. This is an
accepted v1 interaction and is covered by a mixed-quota test.

## Security and Privacy

- Escape configured display copy before inserting it into widget HTML.
- Treat Issue-draft content and context as untrusted user-generated content.
- Enforce bounded strings, key counts, sections, and serialized payload size.
- Do not accept executable templates or callbacks in Worker payloads.
- Do not accept raw labels or browser-selected logical label sets.
- Resolve optional custom labels by server-owned `{repo, variantId}` configuration.
- Continue requiring the existing signed token when Worker auth is enabled.
- Continue redacting URL query strings and hashes.
- Keep screenshots, attachments, annotations, and console logs unavailable for initial variants.
- Host applications remain responsible for masking sensitive host surfaces.
- Do not place secrets, media, transcripts, email addresses, or unconstrained objects in context.
- Public lifecycle events are deferred so answer or context data cannot accidentally become a
  permanent analytics contract.

## Contributor Extension Model

The initial release supports two extension paths:

1. Compose a variant from public fields and presentations.
2. Render custom UI in the host and call `VariantHandle.submit()`.

A public `registerFieldRenderer()` API is deferred because it would freeze DOM lifecycle, styling,
accessibility, sanitization, and serialization contracts for arbitrary code. Headless submission
provides product flexibility without that unsafe commitment.

Every built-in example includes:

- A typed documented configuration.
- A local fixture page.
- Field-controller conformance tests.
- An Issue-draft golden.
- Worker formatting and policy tests.
- A Playwright flow using the public API.

## Testing and Compatibility Gates

Testing is layered. A mocked browser response cannot satisfy a real-GitHub claim, and a real-GitHub
canary is not multiplied across every browser or visual layout.

| Claim | Required proof layer |
| --- | --- |
| Config validation, field normalization, template resolution | Vitest pure-unit tests |
| Generic Issue formatting, bounds, label rejection and mapping | Worker tests with GitHub mocked |
| Each acceptance UX, explicit Submit, errors, reset, cleanup | Local Chromium Playwright with `/feedback` intercepted and exact draft asserted |
| Rating/choice keyboard behavior and modal focus | Focused Chromium, Firefox, and WebKit Playwright |
| Multiple mounts and legacy coexistence | Local Chromium Playwright |
| Legacy v1 request and Issue behavior | Immutable goldens plus tag-reconstructed bundle against candidate Worker |
| Exact deployed bundle, cross-origin behavior, `/widget.js` and `/widget.v1.js` | Locked merge-queue preview Playwright |
| Actual structured Worker rejection | Direct preview requests with no GitHub side effect |
| Preview Worker → GitHub App → real Issue | One locked, zero-retry, independently verified and cleaned canary |

### Legacy regression gate

- Existing script snippets render the same trigger and default form.
- Existing data attributes produce the same config.
- Legacy methods ignore extra arguments, work detached, and remain synchronous.
- `bugdrop:ready` target, timing, count, bubbling, cancelability, and detail remain exact.
- Historical normalized payloads, Issue bodies, labels, response shapes, and storage remain exact.
- A tag-reconstructed v1 bundle submits against the candidate Worker.
- Compressed bundle size stays within the recorded 25% budget and legacy-only bootstrap performs no
  variant instance work.
- Legacy full-page, area, and element capture exclude two simultaneously mounted inline variants.
- Existing screenshot, annotation, retry, locale, theme, Radix, and API-only suites remain green.

### Variant unit and conformance gate

- Complete config validation and descriptive errors.
- Every field passes shared rendering, keyboard, validation, normalization, reset, and disposal tests.
- Template grammar, choice-label resolution, star formatting, escaping, and output bounds.
- Duplicate and reserved ID behavior.
- Independent state for simultaneous mounts.
- Headless and BugDrop-rendered submissions normalize to identical Issue drafts.
- One submission ID survives validation and retry; reset after success creates a new ID.

### Worker gate

- Legacy and structured payloads both succeed through isolated handlers.
- A legacy payload containing an unrelated `schemaVersion` remains legacy.
- Unsupported structured versions and malformed drafts fail before GitHub calls.
- Raw labels, `labelSet`, policy-field injection, oversized values, and nested values are rejected.
- Empty optional sections are omitted.
- Choice display labels and generic formats produce exact Markdown.
- Mandatory attribution, system information, and submission marker cannot be suppressed.
- Mixed legacy and variant traffic consumes the documented shared quota.

### Local and preview E2E gate

- All four acceptance variants run in their intended modal or inline presentation.
- Two inline variants coexist with the legacy widget.
- Repeated mount/unmount leaves no hosts, global listeners, controllers, or shared state.
- Modal arbitration follows the normative matrix in both directions.
- Rating and choice controls never submit without explicit Submit.
- Mobile targets, focus order, Escape, restoration, first-error focus, and live regions are asserted.
- Light, dark, auto, and Bleep-inspired custom styling remain readable.
- A compact variant smoke runs in the existing three-browser local and live matrices.
- The deployed preview loads both `/widget.js` and `/widget.v1.js` from the expected origin and
  verifies their checkout hashes.

### Real-Issue canary strategy

The Phase 0 legacy canary remains the safety baseline while the structured transport is developed.
When the structured handler and headless API are ready, extend the existing canary—not its token or
cleanup framework—to submit one representative field-agnostic variant Issue. That canary verifies
the structured discriminator, generic sections, `{repo, variantId}` labels, marker, attribution,
actual response Worker SHA, canonical Issue URL, and zero-leak cleanup.

Routine merge-group CI creates only one real canary Issue. It does not create one Issue per UX or
browser. Each rendered UX proves its exact normalized draft in deployed/local browser tests; Worker
tests prove that draft's `createIssue` arguments; the single real canary proves the shared deployed
GitHub path. Together these layers cover every variant without multiplying destructive side
effects, retries, notifications, or rate-limit pressure.

## Documentation

Add documentation for:

- Variant concepts and browser API.
- Published TypeScript declarations.
- Field and presentation references.
- Issue templates and server-owned variant label mappings.
- Modal, inline, and headless examples.
- React integration and cleanup.
- Security and context-data guidance.
- Version pinning and the legacy compatibility promise.
- Contributor field-controller conformance tests.
- The distinction between per-UX mocked/deployed coverage and the single real-Issue canary.

The Quick Start remains the current one-line script installation. Variants are an advanced,
explicitly opt-in capability.

## Rollout Plan

### Phase 0: real-Issue preview proof — complete

- Exact preview Worker and widget identity.
- Serialized preview critical section.
- One zero-retry legacy browser submission.
- Independent Issue verification and unconditional cleanup.
- Nonmutating ordinary live paths and documented token rotation.

Evidence: PR #258, run `30724180366`, and closed test Issue #578.

### Phase 1: compatibility and structured headless foundation

- Capture immutable tag-reconstructed v1 bootstrap, payload, response, Issue, storage, and DOM
  goldens with reproducible provenance.
- Publish the additive `.d.ts` browser API contract.
- Add the lazy sidecar registration and durable handle API without moving the legacy call graph.
- Extract only proven transport/metadata seams.
- Add the field-agnostic structured Worker handler and headless submission.
- Add server-owned `{repo, variantId}` label resolution.
- Extend the existing merge-queue canary with one structured representative after local gates pass.

### Phase 2: first rendered UXs

- Add the accessible variant modal and isolated inline presentation.
- Add short text, long text, and rating controllers.
- Ship the one-to-five-star review and CTA-driven question.
- Prove modal arbitration, legacy capture exclusion, Radix coexistence, and TypeScript examples.

### Phase 3: composition and contributor proof

- Add the single-choice controller and compact suggestion.
- Ship the poll and suggestion fixtures.
- Prove two simultaneous inline variants, reset identity, cleanup, and shared conformance tests.
- Add focused Firefox/WebKit and deployed preview coverage.

### Phase 4: dogfood and documentation

- Dogfood selected examples in Bleep without making Bleep-specific copy or fields core branches.
- Publish integration, security, testing, and contributor documentation.
- Broaden usage only after legacy, multi-instance, and structured canary contracts remain green.

### Later: evidence and optional lifecycle surface

- Design caller-supplied versus BugDrop-owned evidence explicitly.
- Add screenshot/evidence support only after legacy capture coexistence is proven.
- Consider lookup, unregistration, lifecycle events, and public renderers only from demonstrated use
  cases.
- Consider a broader legacy runtime refactor only after the sidecar has shipped and goldens are
  stable.

## Acceptance Criteria

The initial extension is ready when:

1. Every pre-existing BugDrop unit and E2E test passes without weakened assertions.
2. Historical exact v1 bundles and payload goldens pass against the candidate Worker.
3. A page with no variant registration is observably unchanged and performs no variant-only work.
4. Legacy methods, extra-argument behavior, detached calls, and `bugdrop:ready` remain exact.
5. The four example variants register from ordinary JavaScript and type-check through published
   declarations.
6. At least two inline instances and the legacy widget coexist without capture, picker, Radix,
   storage, theme, or cleanup interference.
7. A host-rendered form and BugDrop-rendered form produce the same Issue draft.
8. Every successful structured submission returns a positive Issue number and canonical URL.
9. The locked merge-queue canary proves one real structured Issue through the exact preview Worker,
   verifies its complete contract independently, closes it, and proves zero matching Issues remain.
10. Every rendered acceptance UX has local and deployed browser coverage of its exact Issue draft.
11. Rating or choice selection alone never submits.
12. Raw labels and browser-selected label sets are rejected before GitHub calls.
13. New code lives in contributor-oriented sidecar and structured-route modules instead of growing
    the legacy wizard or forcing a legacy controller migration.
14. `/widget.v1.js`, the legacy Worker handler, and the existing JavaScript API remain backwards
    compatible.

## Strongest Failure Modes to Disprove

1. **Legacy regression:** A page that never registers a variant renders, initializes, stores, opens,
   captures, or submits differently. Disprove this with immutable historical goldens, detached and
   extra-argument API tests, and existing E2E.
2. **Wrong preview or false integration proof:** CI tests one widget SHA but submits to another
   Worker, or a mocked response is mistaken for a GitHub Issue. Disprove this using the implemented
   preview lock, checkout widget hash, health SHA, actual response SHA, independent Issue readback,
   and final sweep.
3. **Cross-instance or host interference:** A mounted variant enters a legacy screenshot, becomes
   selectable as evidence, steals Radix focus, or leaks listeners/state. Disprove this with two
   simultaneous mounts, every capture mode, host-dialog focus, and repeated disposal tests.
4. **GitHub policy injection:** A modified browser selects privileged labels, suppresses mandatory
   metadata, or injects unsafe Markdown. Disprove this with direct structured requests that bypass
   widget validation.
5. **False success or duplicate response:** The UI thanks the user without a valid Issue number, a
   retry creates multiple Issues, or reset reuses a completed submission ID. Disprove success gating
   with fault injection and keep the existing real-canary duplicate and cleanup audits.
6. **Modal cancellation deadlock:** Variant coordination removes DOM without settling its promise or
   interferes with an awaited legacy wizard step. Disprove every arbitration transition and assert
   each variant result settles once with focus restored.
7. **Accessibility regression:** Rating or choice works only by pointer, modal focus escapes, or
   inline mounting moves focus. Disprove explicit keyboard flows, semantic assertions, target-size
   checks, and automated accessibility scans.
8. **Contributor extension changes the Worker:** Adding a new field requires a protocol or Worker
   formatter branch. Disprove this with a test-only field descriptor that compiles to the unchanged
   generic Issue-draft contract.
