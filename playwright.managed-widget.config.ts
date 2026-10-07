import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/managed-widget-browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'] },
});
