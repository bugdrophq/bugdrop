import { defineConfig, devices } from '@playwright/test';

const generatedAssetPattern =
  '^(?:widget\\.js|widget\\.v[^/]+\\.js|versions\\.json|checksums\\.sha256|static-package\\.json)$';
const cleanGeneratedAssets = `node -e "const fs=require('fs');const pattern=new RegExp('${generatedAssetPattern}');for(const name of fs.readdirSync('public'))if(pattern.test(name))fs.rmSync('public/'+name)"`;
const releaseInputs = [
  'BUGDROP_BUILD_MODE=release',
  'BUGDROP_VERSION=9.9.9',
  'BUGDROP_RELEASE_TIMESTAMP=2026-08-11T00:00:00Z',
  `BUGDROP_TARGET_SHA=${'a'.repeat(40)}`,
  'BUGDROP_REPOSITORY=bugdrophq/bugdrop',
  `BUGDROP_CONTROLLER_IDENTITY=sha256:${'b'.repeat(64)}`,
  `BUGDROP_TOOL_IDENTITY=sha256:${'c'.repeat(64)}`,
  `BUGDROP_SOURCE_DIGEST=${'d'.repeat(64)}`,
].join(' ');

export default defineConfig({
  testDir: './e2e',
  testMatch: /default-flow-production\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://bugdrop.localhost:8787',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `${cleanGeneratedAssets} && ${releaseInputs} npm run build:widget && npm run dev`,
    url: 'http://bugdrop.localhost:8787',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
