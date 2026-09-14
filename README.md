# BugDrop 🐛

[![CI](https://github.com/bugdrophq/bugdrop/actions/workflows/ci.yml/badge.svg)](https://github.com/bugdrophq/bugdrop/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/bugdrophq/bugdrop?sort=semver)](https://github.com/bugdrophq/bugdrop/releases/latest)
[![Security Policy](https://img.shields.io/badge/Security-Policy-blue)](./SECURITY.md)
[![Live Demo](https://img.shields.io/badge/Demo-Try_It_Live-ff9e64)](https://bugdrop-widget-test.vercel.app)
[![GitHub Marketplace](https://img.shields.io/badge/GitHub%20Marketplace-Install-2ea44f?logo=github)](https://github.com/marketplace/bugdrop-in-app-feedback-to-github-issues)
[![Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1141615&theme=light&t=1778415221018)](https://www.producthunt.com/products/bugdrop-2?utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-bugdrop-2)

In-app feedback → GitHub Issues. Screenshots, annotations, the works.

The Worker also accepts a versioned, field-agnostic structured submission envelope for custom UXs.
It validates bounded Issue drafts, keeps raw GitHub labels server-controlled through
`VARIANT_LABELS`, and reuses the legacy endpoint, authentication, rate limits, GitHub App, and
success response. `window.BugDrop.registerVariant(config).submit(answers)` provides the headless
browser path; rendered modal and inline variants follow in a later phase. Existing script tags and
legacy payloads remain unchanged.

Featured on Product Hunt and ranked #6 Product of the Day on May 9, 2026.

![bugdrop-demo-small](https://github.com/user-attachments/assets/22d234fa-aa0f-4d01-bc4f-4c3e8f107165)

## Quick Start

> Works with both public and private repositories!

**1. Install the GitHub App** on your repository:

https://github.com/marketplace/bugdrop-in-app-feedback-to-github-issues

**2. Add the script** to your website:

```html
<script src="https://bugdrop.neonwatty.workers.dev/widget.js" data-repo="owner/repo"></script>
```

That's it! Users can now click the bug button to submit feedback as GitHub Issues.

> **Important:** Do not add `async` or `defer` to the script tag — the widget needs synchronous loading to read its configuration.

> **CSP note:** If your site uses a Content Security Policy, add `https://bugdrop.neonwatty.workers.dev` to your `script-src` directive to enable the widget.

> **Branch protection:** BugDrop works with repos that have branch protection rules (required PRs, merge queues). Screenshots are stored on a dedicated `bugdrop-screenshots` branch that is auto-created on first use — no manual setup needed.

> **Security note:** BugDrop is not a spam or malware filtering service. Treat feedback and screenshots as unauthenticated user-generated content. Exclude `bugdrop-screenshots` from CI/deploy workflows, and self-host behind your own WAF/CAPTCHA/content controls for stricter environments.

## Features

- 🔒 **Privacy masking** — tag sensitive elements with `data-bugdrop-mask` and BugDrop visually covers them in supported screenshot modes before submission. Passwords and credit-card inputs are masked automatically.

## Widget Options

| Attribute                       | Values                                               | Default               |
| ------------------------------- | ---------------------------------------------------- | --------------------- |
| `data-repo`                     | `owner/repo`                                         | **required**          |
| `data-app-version`              | Host application version (up to 128 characters)      | omitted               |
| `data-theme`                    | `light`, `dark`, `auto`                              | `auto`                |
| `data-locale`                   | `de`, `en`, `nl`, `pl` (region subtags accepted)     | `<html lang>` or `en` |
| `data-position`                 | `bottom-right`, `bottom-left`                        | `bottom-right`        |
| `data-color`                    | Accent color for buttons/highlights (e.g. `#FF6B35`) | `#14b8a6` (teal)      |
| `data-label`                    | Any string                                           | localized label       |
| `data-category-labels`          | JSON mapping for self-hosted category labels         | built-in labels       |
| `data-button`                   | `true`, `false`                                      | `true`                |
| `data-send-console-logs`        | `true`, `false`                                      | `false`               |
| `data-element-context-max-area` | Viewport-area multiplier for Select Element context  | `0`                   |

See [full documentation](https://bugdrop.dev/docs/configuration) for all options including styling, submitter info, and dismissible button.

### Composable feedback flows

`window.BugDrop.registerFlow` registers a versioned modal flow without changing the default BugDrop
button or `registerVariant`. Forms define field groups, screens determine their
order and visibility, and submission still uses BugDrop's established feedback payload.

A default-shaped message → details → optional screenshot journey:

```js
const defaultFlow = window.BugDrop.registerFlow({
  configVersion: 1,
  id: 'default-shaped-feedback',
  presentation: { kind: 'modal' },
  forms: [
    {
      id: 'details',
      title: 'Tell us what happened',
      fields: [
        { id: 'summary', type: 'shortText', label: 'Title', required: true },
        { id: 'description', type: 'longText', label: 'Description' },
        { id: 'attachments', type: 'attachments', label: 'Attachments' },
        { id: 'send-logs', type: 'checkbox', label: 'Include console logs' },
        { id: 'name', type: 'shortText', label: 'Name' },
        { id: 'email', type: 'shortText', label: 'Email' },
      ],
    },
  ],
  screens: [
    { id: 'welcome', type: 'message', title: 'Share feedback' },
    { id: 'details-screen', type: 'form', form: 'details' },
    { id: 'screenshot', type: 'screenshot', mode: 'optional' },
  ],
  issue: {
    classification: 'bug',
    title: '{{details.summary}}',
    sections: [
      {
        heading: 'Description',
        answer: 'details.description',
        omitWhenEmpty: true,
      },
    ],
  },
  evidence: {
    attachments: 'details.attachments',
    sendConsoleLogs: 'details.send-logs',
    submitter: { name: 'details.name', email: 'details.email' },
  },
});

defaultFlow.open();
```

Screens replace one another immediately when `presentation.screenTransition` is omitted or set to
`{ kind: 'none' }`. Built-in motion kinds are `slide-horizontal`, `slide-vertical`, `fade`, and
`scale-fade`; directional strategies reverse on Back. Horizontal slide defaults to 500ms. Every
animated strategy accepts an integer `durationMs` from 100–1000, and BugDrop automatically uses
immediate replacement when the visitor prefers reduced motion.

Custom motion stays serializable and safe inside the widget's shadow DOM. Describe the incoming
screen's starting frame and outgoing screen's ending frame for both navigation directions. Opacity,
pixel translations, and scale can be combined without injecting CSS:

```js
presentation: {
  kind: 'modal',
  screenTransition: {
    kind: 'custom',
    durationMs: 600,
    easing: 'ease-in-out',
    forward: {
      enterFrom: { opacity: 0, translateY: 40, scale: 0.95 },
      exitTo: { opacity: 0, translateY: -20 },
    },
    backward: {
      enterFrom: { opacity: 0, translateY: -20 },
      exitTo: { opacity: 0, translateY: 40, scale: 0.95 },
    },
  },
}
```

A materially different product-triage flow can show follow-up and screenshot screens only for a
bug or a low rating. Conditions are serializable and reference answers from earlier forms:

```js
const needsEvidence = {
  any: [
    { answer: 'triage.kind', equals: 'bug' },
    { answer: 'triage.rating', equals: 1 },
  ],
};

const triageFlow = window.BugDrop.registerFlow({
  configVersion: 1,
  id: 'product-triage',
  presentation: {
    kind: 'modal',
    screenTransition: { kind: 'slide-horizontal' },
  },
  forms: [
    {
      id: 'triage',
      title: 'Classify your feedback',
      fields: [
        {
          id: 'kind',
          type: 'singleChoice',
          label: 'Type',
          required: true,
          options: [
            { value: 'bug', label: 'Bug' },
            { value: 'idea', label: 'Idea' },
          ],
        },
        { id: 'rating', type: 'rating', label: 'Experience', required: true },
        { id: 'summary', type: 'shortText', label: 'Summary', required: true },
      ],
    },
    {
      id: 'detail',
      title: 'Add diagnostic detail',
      fields: [{ id: 'steps', type: 'longText', label: 'Steps to reproduce' }],
    },
  ],
  screens: [
    { id: 'intro', type: 'message', title: 'Help us prioritize' },
    { id: 'triage-screen', type: 'form', form: 'triage' },
    { id: 'detail-screen', type: 'form', form: 'detail', when: needsEvidence },
    { id: 'screenshot', type: 'screenshot', mode: 'optional', when: needsEvidence },
  ],
  issue: {
    classification: 'bug',
    title: '{{triage.summary}}',
    sections: [
      { heading: 'Type', answer: 'triage.kind', format: 'choice' },
      { heading: 'Experience', answer: 'triage.rating', format: 'stars' },
      { heading: 'Steps', answer: 'detail.steps', omitWhenEmpty: true },
    ],
  },
});

triageFlow.open();
```

## Test a Local Widget on a Live Site

Build the widget and start the local server:

```bash
npm run build:widget && npm run dev
```

Then open the live site, open the browser console, and paste the script below. Change the
`script.dataset.repo` value if the site should use a different repository.

```js
(() => {
  const localBase = 'http://127.0.0.1:8787';

  // Local development normally has no GitHub App credentials, so allow the
  // widget to open while leaving every other request unchanged.
  window.__bugdropRealFetch ??= window.fetch.bind(window);
  window.fetch = (input, options) => {
    if (String(input).startsWith(`${localBase}/api/check/`)) {
      return Promise.resolve(
        new Response(JSON.stringify({ installed: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    return window.__bugdropRealFetch(input, options);
  };

  document.querySelector('#bugdrop-host')?.remove();
  delete window.BugDrop;

  document
    .querySelectorAll('script[data-bugdrop-local-test="true"]')
    .forEach(script => script.remove());

  const script = document.createElement('script');
  script.src = `${localBase}/widget.js`;
  script.dataset.repo = 'owner/repo';
  script.dataset.welcome = 'never';
  script.dataset.theme = 'light';
  script.dataset.bugdropLocalTest = 'true';
  script.onload = () => window.BugDrop?.open();
  document.body.appendChild(script);
})();
```

This is intended for testing the widget and screenshot flow only. Submitting feedback still
requires valid GitHub App credentials on the local server. If Chrome asks whether the page may
access devices or services on the local network, allow it so the page can load `widget.js`. Reload
the live page after testing to restore its original widget and `fetch` implementation.

## Documentation

- [Full Documentation](https://bugdrop.dev/docs)
- [Service Status](https://bugdrop.dev/status)
- [Built with BugDrop Showcase](https://bugdrop.dev/showcase)
- [GitHub Marketplace](https://github.com/marketplace/bugdrop-in-app-feedback-to-github-issues)
- [Configuration](https://bugdrop.dev/docs/configuration)
- [Styling](https://bugdrop.dev/docs/styling)
- [JavaScript API](https://bugdrop.dev/docs/javascript-api)
- [Version Pinning](https://bugdrop.dev/docs/version-pinning)
- [CI Testing](https://bugdrop.dev/docs/ci-testing)
- [Merge-queue Issue canary operations](docs/merge-queue-issue-canary.md)
- [Security & Rate Limiting](https://bugdrop.dev/docs/security)
- [Self-Hosting](https://bugdrop.dev/docs/self-hosting)
- [FAQ](https://bugdrop.dev/docs/faq)

Self-hosters can optionally restrict installation checks and feedback destinations with the
server-side [`ALLOWED_REPOSITORIES` setting](https://bugdrop.dev/docs/configuration#allowed-repositories).
It covers legacy and structured submissions; leaving it unset preserves existing behavior.

## How It Works

```
User clicks bug button → Widget captures screenshot → Worker authenticates via GitHub App → Issue created in your repo
```

1. **Widget** loads in a Shadow DOM (isolated from your page styles)
2. **Screenshot** captured client-side using html-to-image
3. **Worker** (Cloudflare) exchanges GitHub App credentials for an installation token
4. **GitHub API** creates the issue with the screenshot stored in `.bugdrop/` on a dedicated `bugdrop-screenshots` branch (auto-created on first use)

## Reliable by design

Reliability is something BugDrop users should be able to inspect, not simply take on trust. We test
the complete path from the browser to Cloudflare, the GitHub App, and the resulting GitHub Issue.

- **Every merge is tested in preview.** The merge queue deploys the candidate Worker, loads the real
  widget in a browser, submits feedback, creates a real GitHub Issue, independently verifies its
  contents and deployment identity, and cleans it up before the change can merge.
- **Production is tested every four hours.** A scheduled heartbeat exercises the complete production
  widget and GitHub Issue lifecycle. Failures create or update one deduplicated incident Issue in
  this repository, and recovery is verified automatically.
- **Checks fail closed.** Deployment identity, browser behavior, Issue verification, cleanup,
  diagnostics, and incident reconciliation must all succeed.
- **Synthetic activity is isolated.** Preview and production use separate markers, cleanup
  boundaries, and concurrency controls so their tests cannot interfere with each other.

This coverage has grown from pre-merge preview validation into scheduled production verification.
We will keep turning new failure modes and operational lessons into repeatable checks, with public
workflow history as evidence. View the current component health and incident history on the
[public service status page](https://bugdrop.dev/status). Inspect the
[merge-queue checks](https://github.com/bugdrophq/bugdrop/actions/workflows/ci.yml) and
[production heartbeat](https://github.com/bugdrophq/bugdrop/actions/workflows/production-heartbeat.yml),
or read the detailed [preview canary](docs/merge-queue-issue-canary.md) and
[production heartbeat](docs/production-heartbeat.md) designs.

## Live Demo

Try it on [WienerMatch](https://bugdrop-widget-test.vercel.app) — click the bug button in the bottom right corner.

## License

MIT
