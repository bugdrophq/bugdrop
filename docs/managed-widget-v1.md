# Managed widget v1 qualification

This opt-in widget connects the browser SDK's submission-token callback to the
managed submission protocol. It collects a title, description, and category and
shows a delivery receipt or an uncertain outcome. It does not collect screenshots,
attachments, console logs, repository selectors, or customer identity.

## Build and load

Run `npm run build:widget:managed`. The output is
`dist/managed-widget/widget.managed.v1.js`. The legacy widget build, public assets,
release manifest, and deployment entry points do not include it. No production
managed widget URL is activated by this change.

For a controlled test venue, serve this artifact over HTTPS on the same origin as
the managed `/v1/submissions` service. Initialize `@bugdrop/browser` with its
`widgetUrl` pointing to that artifact and a `tokenProvider(binding)` that obtains a
short-lived submission capability from the application's backend. The callback
receives `{ submissionId, payloadDigest }`; return the SDK's versioned capability
object, including its expiration. The SDK validates that object and passes only
the token to the widget. Never place a server credential in browser code.

The script must have the SDK's `data-contract-version="1"`, application ID, and
named token-provider attributes. The widget implements the SDK's open, close,
show, hide, state-query, and theme methods, plus its ready event. It supports
button visibility, left/right positioning, and light/dark/automatic themes.

## Submission behavior

The widget validates and freezes the feedback, serializes it once, and computes
the base64url SHA-256 digest of the exact UTF-8 request bytes. Each manual attempt
obtains a fresh capability for the same submission ID and digest. There is no
automatic retry and no fallback to legacy `/feedback`.

Each attempt allows up to 10 seconds for authorization, then up to 10 seconds
for the submission response, including its bounded body read. Slow authorization
does not consume the delivery window. A provider that settles after its deadline
cannot trigger a submission. Either timeout still requires the existing manual
recovery flow; no request is retried automatically.

An uncertain result keeps the draft locked. **Check result** submits the same
logical submission again, allowing the service to return its existing receipt.
An initial definitive request, size, or access rejection offers **Edit feedback**
without discarding the draft. Any earlier uncertain result keeps editing locked.
Closing and reopening preserves the frozen submission in memory. Before any
capability request or delivery attempt, the widget durably claims an unresolved
marker in localStorage under a Web Lock. Reloading loses the frozen report but
retains that marker: the new document blocks feedback and asks the reporter to
contact the site owner. It does not offer Check result without the original
bytes/identity, reconstruct a report, or automatically resend.

The marker stores only a random ownership nonce. It contains no title, description,
digest, submission ID, receipt, capability or customer identity. Browser origin
storage plus public Application ID and exact managed destination scope the lock.
Concurrent tabs in that scope cannot start competing reports. Because V1 has no
customer session identity, the lock deliberately spans sign-out/sign-in and other
sessions in that browser; it never exposes a previous reporter's content. Another
Application or destination has a separate lock. A fresh browser/profile, explicit
storage deletion, or browser eviction cannot retain this client-side protection;
this is not cross-device duplicate detection or full report recovery.

Only a confirmed delivered outcome or an initial definitive editable rejection
clears an owned marker. A denial following uncertainty cannot clear it. Missing
Web Locks, unreadable/unwritable storage, corrupt or foreign markers fail closed
with a visible locked state and no new capability/delivery request. A failed clear
also prevents another report. There is no automatic expiry or reporter-facing
force-reset button. For an unresolved reload, the site owner must first reconcile
authoritative delivery/receipt evidence, then assist the reporter in removing only
this Application/destination's localStorage marker; never advise blanket storage
clearing or retyping the report as a retry. This manual beta procedure does not
claim an automated reconciliation API.

Only the versioned delivered response with the expected HTTP status and a valid
receipt ID produces a delivered confirmation. A verifier-only response, malformed
body, network failure, or timeout cannot produce success. The receipt is not an
Issue URL. Submission tokens are never rendered or stored by the widget.

## Acceptance evidence

Unit tests cover validation, exact request binding, concurrency, response parsing,
timeouts, and dialog state. The browser qualification installs the SDK from an npm
tarball in a temporary consumer and exercises the actual bundled widget in
Chromium. Its service responses are intercepted; it creates no real Issue.

```sh
# Build the public SDK in a separate checkout first.
npm ci --prefix /path/to/bugdrop-sdk-typescript
npm run build --prefix /path/to/bugdrop-sdk-typescript
BUGDROP_MANAGED_SDK_ROOT=/path/to/bugdrop-sdk-typescript npm run test:widget:managed
```

CI pins SDK commit `bab479314914dad3372b043b3dbcf17f132fff3a`, builds and packs it,
and runs this browser qualification as part of **Unit Tests & Build**. The strongest
failure case drops the first response, then verifies that retry preserves the
exact body, submission ID, and digest while obtaining a fresh token. It also
rejects verifier-only success and checks keyboard dialog access. Reload regressions
prove that a lost response followed by a real page reload cannot start a replacement
report, including after a subsequent denial. Concurrent tabs, corrupt storage,
unavailable locks/storage and failed durable writes also fail closed. These checks
intercept network responses and do not constitute live GitHub acceptance.

This qualifies the browser boundary. Real dogfooding still requires the separately
reviewed managed delivery host, current destination resolution, fixture Issue
delivery, and account activity reconciliation. Mocked responses do not establish
those capabilities.
