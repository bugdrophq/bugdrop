# Security Policy

## Supported Versions

Security fixes are provided for the latest stable release and the current hosted service. Fixes
normally land on `main` and are included in the next stable release. Older releases and
version-pinned assets are not guaranteed to receive backports, so self-hosters should upgrade to the
latest stable release before requesting a fix for an older version.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately through one of these channels:

1. **Preferred:** [GitHub private vulnerability reporting](https://github.com/bugdrophq/bugdrop/security/advisories/new)
2. **Email fallback:** [neonwatty@gmail.com](mailto:neonwatty@gmail.com) or
   [jeremy@mean-weasel.com](mailto:jeremy@mean-weasel.com)

Ordinary email is not end-to-end encrypted. Use GitHub private vulnerability reporting for reports
that contain sensitive details, credentials, or unpublished exploit material. Do not open a public
GitHub issue. If the preferred channel is unavailable, use either email fallback rather than
disclosing the issue publicly.

Include, when available:

- A description of the vulnerability and its potential impact
- The affected release, hosted URL, or commit
- Reproduction steps or a minimal proof of concept
- Relevant configuration and environmental details, with secrets removed
- Whether you plan to publish the report and any requested disclosure timeline

## Response Targets

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 7 days
- **Remediation:** Typically 30-90 days, depending on severity and complexity

These are best-effort targets rather than guarantees. The maintainers will share material status or
timeline changes through the private reporting channel.

## Scope

This policy covers:

- The Cloudflare Worker (`src/`)
- The client widget (`src/widget/`)
- Release artifacts published by this repository
- The hosted instance at `bugdrop.neonwatty.workers.dev`
- Dependency vulnerabilities that are reachable through or materially affect BugDrop

Self-hosted deployment configuration is controlled by the instance owner. Reports about an upstream
dependency with no BugDrop-specific impact should go to that upstream project, but reports showing
that BugDrop is affected are in scope here.

## Triage and Coordinated Disclosure

The BugDrop repository maintainers own intake and triage. They will validate the report, assess
severity using reachability and user impact, and prioritize critical and high-severity issues. When a
dependency is involved, the maintainers will determine BugDrop's exposure, coordinate with the
upstream project when appropriate, and update affected BugDrop releases or guidance.

Please allow time for investigation and remediation before public disclosure. The maintainers will
coordinate a disclosure date with the reporter, publish a GitHub security advisory or CVE when
appropriate, and credit reporters who request attribution and consent to being named.
