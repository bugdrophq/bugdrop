import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8787';
const issueCanaryProject = 'chromium-issue-canary';
const liveProjects = [
  'chromium-live',
  'chromium-flow-live',
  'chromium-live-radix',
  'chromium-cross-browser-live',
  'firefox-cross-browser-live',
  'webkit-cross-browser-live',
] as const;
const explicitlySelectedProjects = new Set(
  process.argv.flatMap((argument, index, arguments_) => {
    if (!argument.startsWith('--project=') && argument !== '--project') return [];

    const projectValues = arguments_.slice(index + 1);
    const nextOptionIndex = projectValues.findIndex(project => project.startsWith('-'));
    const followingProjects =
      nextOptionIndex === -1 ? projectValues : projectValues.slice(0, nextOptionIndex);
    return argument.startsWith('--project=')
      ? [argument.slice('--project='.length), ...followingProjects]
      : followingProjects;
  })
);
const issueCanaryExplicitlySelected = explicitlySelectedProjects.has(issueCanaryProject);
const liveProjectExplicitlySelected = [...explicitlySelectedProjects].some(selector =>
  liveProjects.some(project => projectSelectorMatches(selector, project))
);
const liveInputsAvailable = Boolean(process.env.LIVE_TARGET && process.env.PLAYWRIGHT_BASE_URL);
const issueCanaryTest = /.*\.issue-canary\.spec\.ts$/;
const noTests = /$a/;

function projectSelectorMatches(selector: string, project: string): boolean {
  const pattern = selector
    .toLocaleLowerCase()
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(project.toLocaleLowerCase());
}

if (liveProjectExplicitlySelected && !liveInputsAvailable) {
  throw new Error('Live Playwright projects require both LIVE_TARGET and PLAYWRIGHT_BASE_URL.');
}

function liveTestMatch(pattern: RegExp): RegExp {
  return liveInputsAvailable ? pattern : noTests;
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [
        /.*\.(?:live|flow-live|live-radix|cross-browser-live|issue-canary|radix)\.spec\.ts$/,
        /default-flow-production\.spec\.ts$/,
      ],
    },
    {
      name: 'chromium-radix',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /.*\.radix\.spec\.ts/,
    },
    {
      name: 'firefox-radix',
      use: { ...devices['Desktop Firefox'] },
      testMatch: /.*\.radix\.spec\.ts/,
    },
    {
      name: 'webkit-radix',
      use: { ...devices['Desktop Safari'] },
      testMatch: /.*\.radix\.spec\.ts/,
    },
    {
      name: 'webkit-mobile',
      use: { ...devices['iPhone 11'] },
      testMatch: /annotation-zoom-pan\.spec\.ts$/,
      timeout: 60_000,
    },
    {
      name: 'chromium-live',
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
      },
      testMatch: liveTestMatch(/.*\.live\.spec\.ts/),
      timeout: 60_000,
    },
    {
      name: 'chromium-flow-live',
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
      },
      testMatch: liveTestMatch(/.*\.flow-live\.spec\.ts/),
      timeout: 60_000,
    },
    {
      name: 'chromium-live-radix',
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
      },
      testMatch: liveTestMatch(/.*\.live-radix\.spec\.ts/),
      timeout: 60_000,
    },
    {
      name: 'chromium-cross-browser-live',
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
      },
      testMatch: liveTestMatch(/.*\.cross-browser-live\.spec\.ts/),
      timeout: 60_000,
    },
    {
      name: 'firefox-cross-browser-live',
      fullyParallel: false,
      use: {
        ...devices['Desktop Firefox'],
      },
      testMatch: liveTestMatch(/.*\.cross-browser-live\.spec\.ts/),
      timeout: 60_000,
    },
    {
      name: 'webkit-cross-browser-live',
      fullyParallel: false,
      use: {
        ...devices['Desktop Safari'],
      },
      testMatch: liveTestMatch(/.*\.cross-browser-live\.spec\.ts/),
      timeout: 60_000,
    },
    {
      name: issueCanaryProject,
      fullyParallel: false,
      workers: 1,
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
        screenshot: 'off',
        trace: 'off',
        video: 'off',
      },
      // An unqualified `playwright test` must not discover the real-Issue canary.
      testMatch: issueCanaryExplicitlySelected ? issueCanaryTest : noTests,
      timeout: 60_000,
    },
  ],
  webServer: process.env.LIVE_TARGET
    ? undefined
    : {
        command: 'BUGDROP_TEST_HOOKS=1 npm run build:widget && npm run dev',
        url: 'http://localhost:8787',
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
      },
});
