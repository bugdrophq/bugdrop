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

An uncertain result keeps the draft locked. **Check result** submits the same
logical submission again, allowing the service to return its existing receipt.
An initial definitive request, size, or access rejection offers **Edit feedback**
without discarding the draft. Any earlier uncertain result keeps editing locked.
Closing and reopening the dialog preserves this state in memory. Reloading or
leaving the page loses this in-memory state; the widget does not persist feedback
or tokens. Resolve an uncertain result before reloading or submitting it anew.

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

CI pins SDK commit `2fe487d319ffbee0fc85ae80c06b5f549c2bcd80`, builds and packs it,
and runs this browser qualification as part of **Unit Tests & Build**. The strongest
failure case drops the first response, then verifies that retry preserves the
exact body, submission ID, and digest while obtaining a fresh token. It also
rejects verifier-only success and checks keyboard dialog access.

This qualifies the browser boundary. Real dogfooding still requires the separately
reviewed managed delivery host, current destination resolution, fixture Issue
delivery, and account activity reconciliation. Mocked responses do not establish
those capabilities.
