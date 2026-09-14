# Terms of Service

**Last updated:** February 2025

## Overview

BugDrop is a free, open-source feedback widget that creates GitHub Issues with screenshots. These terms apply to the hosted service at `bugdrop.neonwatty.workers.dev`. If you self-host BugDrop, these terms do not apply to your instance.

## Use of the Service

- BugDrop is provided **free of charge** with no guarantees of uptime or availability.
- You may use the hosted widget on any website where you have authority to add scripts.
- You must have the GitHub App installed on a repository you own or administer.
- Do not use the service to submit spam, abusive content, or illegal material via GitHub Issues.
- The hosted service is not a spam, malware, or content moderation service. Feedback submissions are unauthenticated user-generated content.

## No Warranty

THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. THE AUTHORS ARE NOT LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM USE OF THE SERVICE.

## Rate Limits

The service enforces rate limits (10 requests per IP per 15 minutes, 50 per repository per hour) to prevent abuse and protect GitHub API quotas. Exceeding these limits will result in temporary throttling.

For stricter security or compliance requirements, self-host BugDrop and apply your own WAF, CAPTCHA, logging, retention, and content filtering controls.

## GitHub

BugDrop interacts with GitHub on your behalf via the GitHub App. Your use of GitHub is subject to [GitHub's Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service). BugDrop requests only the minimum permissions needed: Issues (read/write) and Contents (read/write) on repositories where you install it.

## Open Source

BugDrop is licensed under the [MIT License](./LICENSE). You are free to self-host, modify, and distribute it under the terms of that license.

## Changes

These terms may be updated from time to time. Changes will be reflected in this file in the repository.

## Contact

For questions, open an issue at [github.com/bugdrophq/bugdrop](https://github.com/bugdrophq/bugdrop).
