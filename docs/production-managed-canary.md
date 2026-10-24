# Production App canary compatibility

This change prepares the existing production App `neonwatty-bugdrop` (`2508027`)
for a gated private-account test using GitHub account `335115387`
(`jermwattml-svg`). It does not deploy, change App settings, enable the private
account, provision any managed bindings, or qualify two lifecycle cycles.

Set `MANAGED_CANARY_EXCLUSION_ENABLED=1` only on the hosted production runtime
before installing the production App for that account. The public API must not
mint an installation token for the canary and bypass its private SDK disconnect.
The current login is denied before provider access; provider-resolved account ID
`335115387` is also denied to cover aliases and renames. With this opt-in enabled,
incomplete provider account identity fails closed. Other numeric accounts retain
their existing token path. Self-hosted/default configuration stays unchanged.
This is a negative public-API guard, not managed account authority or storage.

For webhook secret rotation, add the new credential as
`GITHUB_WEBHOOK_SECRET_NEXT` while preserving the existing
`GITHUB_WEBHOOK_SECRET`. Both signatures are verified against the original body.
An invalid next-secret configuration rejects delivery; it never accepts an
unverified event. Confirm both credentials' behavior before switching the App's
webhook configuration. The new receiver must preserve the legacy receiver for
other accounts, including its event/delivery headers and response status. Keep
an overlap until outstanding deliveries and rollback requirements are resolved;
retirement is a separate explicit step. Do not change App permissions or revoke
existing private keys to perform this rollout.

The version-nine public fingerprint declares exactly four source changes. Its
test independently compares every other public file with the pinned prior tree,
including every widget asset, build input and deployment configuration. No
receipt, budget, counter or installation namespace may be recreated or reset.

Use the normal reviewed PR/merge checks and protected production-release runbook.
Do not use an unreviewed wrapper or a direct deployment to bypass release gates.
Before a new pair, verify the live source, public canary denial, receiver
signature handling and unrelated-customer preservation. Account test acceptance
still requires two distinct full private SDK cycles, reset after each, and no
manual recovery. Legacy public API success cannot substitute for SDK acceptance.
