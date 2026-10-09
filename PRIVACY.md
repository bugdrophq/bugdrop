# Privacy Policy

**Last updated:** October 9, 2026

BugDrop is an open-source feedback widget that creates GitHub Issues. This policy covers
the hosted BugDrop widget and service, as well as the BugDrop website at
[bugdrop.dev](https://bugdrop.dev).

## Feedback Data

When someone submits feedback, BugDrop processes:

- The submitted title, description, category, and optional attachments
- A screenshot when the site configures screenshots as optional, automatic, or required;
  automatic mode attempts to capture and attach a full-page screenshot on submission
  without a preview, but a submission may proceed without one on very complex pages or if
  capture fails
- Browser, operating system, viewport, language, and page information
- Recent console messages, timestamps, and source locations, only when the reporter chooses
  to include console logs
- Optional name and email fields, when enabled by the site owner and completed by the
  reporter

This data is used only to create the requested GitHub Issue and associated files. Feedback
content is not retained in a BugDrop analytics database. It is sent to GitHub and stored
in the repository selected by the site owner.

The widget keeps a limited number of recent console entries in browser memory while the
page is open. Console entries are not sent unless the reporter chooses to include them.
BugDrop applies best-effort secret redaction, but console output can still contain personal
or confidential information. Reporters should consider that risk before choosing to
include it.

## Installation Information

The hosted service retains a minimal record for active GitHub App installations. The record
contains:

- GitHub App installation ID
- Public GitHub account name, account type, and profile link
- Installation date

BugDrop also maintains a best-effort, unrounded per-installation count of successful GitHub
Issues created through the hosted BugDrop service. The count begins when this collection is
enabled and covers successful feedback across repositories available through the
installation.

This information is used to operate BugDrop, understand aggregate adoption and meaningful
use, and invite app owners to participate voluntarily in product research or social proof.
The installation record and count do not retain repository names, issue content,
screenshots, page URLs, reporter identities, IP addresses, feedback timestamps, or
last-active dates for product analytics.

## Installation Completion Counts

When enabled, BugDrop counts completed installations of the public GitHub App by their
UTC creation date. These daily totals help us understand adoption across acquisition
sources. They are not joined to website visitor identifiers and do not establish which
visit, page, or campaign led to an installation.

To avoid counting a redelivered GitHub webhook twice, BugDrop temporarily stores an opaque
receipt generated with a secret key from the GitHub App and installation IDs. These
receipts are pseudonymous, not anonymous. The daily counter does not store the underlying
IDs, account names, repository names, URLs, IP addresses, or webhook bodies. Daily reporting
contains only the date, count, collection start time, and reporting update time.

Receipts remain eligible for deduplication until 30 days after the end of the installation's
UTC creation day. Cleanup is scheduled when that window closes; service outages may delay
erasure. Later redeliveries cannot reopen the window. Uninstalling the app deletes the
separate installation record and usage count, but does not immediately remove these
short-lived receipts or the aggregate daily total. Daily aggregate totals may be retained
indefinitely after receipts are erased.

## Public Statistics

BugDrop may publish rounded, aggregate statistics such as:

- Total GitHub App installations
- Total feedback issues created

Public statistics are not broken down by installation and do not identify individual
apps, repositories, or reporters.

Installation-level counts are private and will not be published or attributed to an app,
account, organization, or repository without explicit permission from an authorized
representative.

## App Names, Logos, Links, and Testimonials

Installing or using BugDrop does not give BugDrop permission to publicly identify an app
or organization.

BugDrop will display an app name, logo, link, quote, or testimonial only after receiving
explicit permission from an authorized representative. That permission may be withdrawn
at any time.

## What BugDrop Does Not Collect for Analytics

BugDrop does not:

- Track individual feedback reporters
- Build profiles of reporters
- Store feedback content or screenshots outside GitHub
- Retain repository names for product analytics
- Sell personal information
- Share installation information for advertising
- Use widget telemetry for cross-site tracking or fingerprinting

The widget does not set analytics cookies or use browser storage to track reporters.

## Website Analytics

The bugdrop.dev marketing and documentation website uses limited analytics to understand
page visits, referral sources, campaign attribution, interactions, and site performance.

Website analytics are separate from the BugDrop widget. The website stores a random
analytics identifier and first-touch attribution information in browser storage. It may
send query-free page paths and page locations, query-free referrer locations, coarse
referrer and campaign categories, controlled interaction labels and destinations, and
site-performance measurements to Google Analytics and PostHog. Raw query values and full
referrer URLs are not included in BugDrop's custom analytics events. Those analytics are
not connected to feedback content or reporter identities.

Google Analytics enhanced measurement is enabled for page views, scrolling, outbound
links, embedded video engagement, file downloads, and form interactions. Automatic site
search measurement is disabled so Google Analytics does not extract search terms from URL
query parameters.

The analytics providers receive network information needed to process requests, including
IP addresses. PostHog may use a client IP address temporarily for pre-storage processing,
such as geolocation or bot detection, but the project is configured to discard the raw IP
before storing the event.

The values stored by BugDrop in the browser do not currently expire automatically and
remain until the visitor clears the site's browser data. Google Analytics and PostHog may
set additional cookies or browser identifiers. Visitors can block browser storage or
analytics requests using their browser or privacy tools. BugDrop does not currently offer
a first-party analytics opt-out control.

Website analytics retention is described in the Retention section below.

## Where Feedback Data Goes

Feedback is sent to the GitHub API and created as a GitHub Issue in the repository
configured by the site owner. Screenshots are stored in that repository's `.bugdrop/`
directory, and attachments are stored in `.bugdrop/uploads/`, on the
`bugdrop-screenshots` branch. Included console logs are written into the GitHub Issue body.

The hosted BugDrop service runs on Cloudflare Workers and processes submissions in memory
while communicating with GitHub.

## Abuse Prevention and Operational Data

The hosted service temporarily stores rate-limit counters to prevent abuse:

- A counter keyed by the raw client IP address expires 15 minutes after its most recent
  update.
- A counter keyed by the destination repository name expires one hour after its most
  recent update.

To prevent successful feedback retries from being counted twice, the anonymous aggregate
feedback counter and each installation feedback counter retain up to 1,024 recent random
identifiers. The random deduplication
identifiers contain no account, repository, Issue, reporter, feedback content, or timestamp
information. Older identifiers are replaced as newer ones arrive. Aggregate identifiers may
remain until replaced; per-installation identifiers are deleted with the installation
counter when the app is uninstalled.

The rate-limit identifiers are used only to enforce submission limits and are not used for
product analytics. Cloudflare may also temporarily process request and network metadata,
including request paths, for service delivery, security, and operational logs.

## Retention

- Feedback content is discarded by the hosted service after the GitHub request completes.
- IP-based rate-limit records expire 15 minutes after their most recent update.
- Repository-based rate-limit records expire one hour after their most recent update.
- Installation records and their successful-feedback counts are retained while an
  installation is active and deleted when the app is uninstalled. A scheduled cleanup
  independently removes both records for installations GitHub no longer reports as active.
- After uninstall, BugDrop retains a deletion guard derived from the GitHub App installation
  ID for up to seven days solely to prevent delayed submissions from recreating a usage
  count. The guard contains only an expiry time—no account, repository, Issue, reporter, or
  feedback content—and expires automatically.
- Installation-completion deduplication receipts are scheduled for erasure 30 days after
  the end of the installation's UTC creation day, independently of uninstall. Service
  outages may delay cleanup. Daily aggregate completion totals may be retained indefinitely.
- Anonymous aggregate totals may be retained indefinitely.
- Testimonial and contact information provided with explicit permission is retained until
  that permission is withdrawn or the information is no longer needed.
- Website analytics identifiers stored in the browser remain until the visitor clears the
  site's browser data.
- Google Analytics retains identifier-associated event data for two months and user data
  for 14 months; the user-data period resets with new activity. Aggregated reporting is not
  governed by these settings.
- PostHog reports an 84-month, plan-derived event-retention window, but automated
  enforcement is currently disabled. BugDrop therefore does not promise that PostHog
  event data will be automatically deleted after 84 months.

## Service Providers

BugDrop relies on:

- GitHub to host installations, Issues, and screenshot files
- Cloudflare to operate the hosted API and deliver parts of bugdrop.dev
- Vercel to deliver bugdrop.dev
- Google Analytics and PostHog for website analytics
- YouTube for the embedded demonstration video

Each provider processes information under its own privacy terms.

## Self-Hosting

BugDrop is open source and self-hostable. Self-hosted installations control their own data
processing, storage, logging, analytics, security, and retention practices. This policy
does not govern independent self-hosted deployments. See
[SELF_HOSTING.md](./SELF_HOSTING.md) for instructions.

## Your Choices

Installation owners may request access to, correction of, or deletion of their retained
installation information. They may also decline outreach or withdraw permission to use
their name, logo, link, or testimonial.

To make a privacy request, email [privacy@bugdrop.dev](mailto:privacy@bugdrop.dev).

## Changes to This Policy

Material changes will be published before the related collection begins. The "Last
updated" date will identify the latest revision.
