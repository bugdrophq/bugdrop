# Issuance-only HTTPS gateway (code only)

`https-gateway.ts` is a proposed stateless public boundary in front of the private
staging ingress. The checked-in config is disabled, has no approved account or
origin, no routes, no workers.dev/previews, and no secrets. Nothing has been
provisioned or activated. The single `STAGING_CAPABILITY_INGRESS` binding targets
the default `bugdrop-managed-ingress-staging` handler; it is not a provider-enforced
path-scoped capability. That backend also contains webhook intake, so the gateway's
path restriction is a security boundary.

When independently approved and enabled, only POST to exactly
`GATEWAY_ORIGIN + /v1/submission-capabilities` is forwarded. The configured origin
must be canonical HTTPS with a DNS hostname, no port, credentials or URL suffix.
Every other observable method/URL, including webhook, submission, control and
observation paths, is rejected before the binding call. Queries, visible fragments,
encoded paths and trailing slashes are not allowed. Host must match if present.
URL parsers/providers may normalize dot segments or host spelling before Worker
execution; the gateway cannot recover original wire bytes. A normalized request
can reach only the fixed issuance path. Strict original-wire rejection needs
separate provider qualification and is not claimed by local tests.

Content-Type must be exactly application/json, with no Content-Encoding. Accept,
contract version and SDK version must match the existing 0.1.0 issuance contract.
Only Authorization, Accept, Content-Type, X-BugDrop-Contract-Version and
X-BugDrop-SDK-Version are forwarded. Authorization is unchanged and issuer-owned,
including missing/invalid values. The JSON body is never parsed or reserialized.
Application origin is a JSON field validated by the issuer; it is not inferred
from the collector host or rewritten. Cookie, Access, GitHub, control, observation
and proxy-identity headers are not forwarded.

The 8-second whole-exchange deadline, 64-KiB request/response byte limits and
16-KiB forwarded-header limit are explicit proposed compatibility constraints.
The current SDK harness uses a 10-second timeout and has no wire response cap;
its parsed token bound does not imply a wire-byte bound. These gateway constraints
may reject otherwise SDK-acceptable slow or oversized responses. No retry occurs.
Cancellation is best effort: a timeout does not prove downstream issuance stopped;
acceptance must still drain/seal its independently observed run.

A response is buffered completely before returning success. Only upstream
200/403/503, JSON Content-Type and exact no-store are accepted. Any redirect,
Location, Set-Cookie, Content-Encoding, unexpected status, oversized/stalled body
or transport failure yields fixed HTTP502. Only Content-Type and Cache-Control
are returned; body bytes and allowed status are preserved. Local admission failures
are fixed HTTP404. Neither gateway404 nor gateway502 is issuer403 evidence.

No logging or credential derivation is implemented. Derived bearer credentials
still transit gateway memory. Source disables observability, Logpush and tails,
but does not prove suppression of provider HTTP/security logs. Query rejection
occurs after provider ingress; no zero-retention claim is made. Never use an OAuth
callback hostname for this endpoint.

Before deployment, approve the external issuance hostname, exposure and limits,
resource/cost/logging policy, exact uploaded bundle/build/version/config provenance,
service target version/config drift checks and rollback inventory. Service bindings
follow deployed services, not immutable bundle pins. Existing historical provenance
gaps remain open. Do not weaken the private readiness descriptor's empty-route
requirements or acceptance:false result to accommodate this different boundary.

Rollback must deny gateway traffic first, remove only newly approved domain/DNS
resources, separately audit/remove the generated certificate, then remove the
new binding/Worker if approved. Preserve existing Worker/DO/SQL state and permanent
uninstall fences. Drain in-flight runs; route removal cannot undo minted capabilities.

Public webhook is deliberately unavailable here. Genuine GitHub uninstall delivery,
private submission transport, dual-ack observers, proxy revocation where used,
live restart evidence and the unconditional uninstall safety blocker remain separate
requirements. This gateway does not establish full20 or staging_passed acceptance.

Local tests use synthetic data, actual local Workers, and fixed service spies:
`npx vitest run test/managed/https-gateway*.test.ts`. Runtime fixtures restore the
URL Host after Miniflare's loopback transport rewrites it; direct unit tests retain
conflicting-Host rejection checks. These are not remote acceptance results.
