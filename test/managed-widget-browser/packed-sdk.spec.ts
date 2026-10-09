import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page, type Route } from '@playwright/test';

const origin = 'https://managed-widget.localhost';
const appOrigin = 'https://fixture-app.localhost';
const receiptId = '00000000-0000-4000-8000-000000000001';
type Binding = { submissionId: string; payloadDigest: string };
type Controller = {
  ready: Promise<void>;
  open(): void;
  close(): void;
  show(): void;
  hide(): void;
};
type FixtureWindow = Window & {
  PackedBugDrop: { init(options: Record<string, unknown>): Controller };
  controller: Controller;
  bindings: Binding[];
};

async function boot(
  page: Page,
  submit: (route: Route) => Promise<void>,
  button = true,
  providerDelayMs = 0
) {
  const widget = await readFile('dist/managed-widget/widget.managed.v1.js', 'utf8');
  const sdk = await readFile('dist/managed-widget/packed-sdk.js', 'utf8');
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url === `${appOrigin}/`) {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><button id="host">Host app</button>',
      });
    } else if (url === `${origin}/widget.managed.v1.js`) {
      await route.fulfill({ contentType: 'application/javascript', body: widget });
    } else if (url === `${origin}/v1/submissions`) {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': appOrigin,
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-BugDrop-Submission-Id',
          },
        });
      } else await submit(route);
    } else {
      throw new Error(`Unexpected request: ${url}`);
    }
  });
  await page.goto(appOrigin);
  await page.addScriptTag({ content: sdk });
  await page.evaluate(
    async ({ origin, button, providerDelayMs }) => {
      const fixture = window as unknown as FixtureWindow;
      fixture.bindings = [];
      fixture.controller = fixture.PackedBugDrop.init({
        applicationId: 'app_managed_browser_fixture',
        widgetUrl: `${origin}/widget.managed.v1.js`,
        button,
        theme: 'dark',
        position: 'bottom-left',
        tokenProvider: async (binding: Binding) => {
          fixture.bindings.push({ ...binding });
          if (providerDelayMs) await new Promise(resolve => setTimeout(resolve, providerDelayMs));
          return {
            schemaVersion: 1,
            token: `fixture-token-${fixture.bindings.length}+/=`,
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          };
        },
      });
      await fixture.controller.ready;
    },
    { origin, button, providerDelayMs }
  );
  return page.locator('#bugdrop-managed-host');
}

test('slow authorization leaves time to confirm the first delivery', async ({ page }) => {
  let submissions = 0;
  const host = await boot(
    page,
    async route => {
      submissions++;
      await new Promise(resolve => setTimeout(resolve, 3000));
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': appOrigin },
        contentType: 'application/json',
        body: JSON.stringify({ schemaVersion: 1, status: 'delivered', receiptId }),
      });
    },
    true,
    8000
  );
  await host.locator('[data-action="open"]').click();
  await host.locator('input[name="title"]').fill('Slow authorization');
  await host.locator('textarea[name="description"]').fill('Confirm the first delivery.');
  await host.locator('[data-action="submit"]').click();
  await expect(host.locator('[data-role="receipt"]')).toContainText(receiptId, { timeout: 20000 });
  await expect(host.locator('[data-role="status"]')).toHaveText('Feedback delivered.');
  await expect(host.locator('[data-action="check-result"]')).toBeHidden();
  expect(submissions).toBe(1);
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).bindings.length)).toBe(1);
});

test('lost response retries one frozen submission through the packed SDK', async ({ page }) => {
  const requests: { body: string; id: string; authorization: string }[] = [];
  const host = await boot(page, async route => {
    const request = route.request();
    requests.push({
      body: request.postData()!,
      id: request.headers()['x-bugdrop-submission-id'],
      authorization: request.headers().authorization,
    });
    if (requests.length === 1) await route.abort('failed');
    else
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': appOrigin },
        contentType: 'application/json',
        body: JSON.stringify({ schemaVersion: 1, status: 'delivered', receiptId }),
      });
  });
  await host.locator('[data-action="open"]').click();
  await host.locator('input[name="title"]').fill('Unicode café 🐞');
  await host.locator('select[name="category"]').selectOption('bug');
  await host
    .locator('textarea[name="description"]')
    .fill('A real packed SDK with an uncertain response.');
  await host.locator('[data-action="submit"]').click();
  await expect(host.locator('[data-action="check-result"]')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('managed-result.png') });
  await expect(host.locator('input[name="title"]')).toBeHidden();
  await page.evaluate(() => (window as unknown as FixtureWindow).controller.close());
  await page.evaluate(() => (window as unknown as FixtureWindow).controller.open());
  await host.locator('[data-action="check-result"]').click();
  await expect(host.locator('[data-role="receipt"]')).toContainText(receiptId);
  await expect(host.locator('[data-role="status"]')).toContainText(/delivered/i);
  expect(requests).toHaveLength(2);
  expect(requests[1].body).toBe(requests[0].body);
  expect(requests[1].id).toBe(requests[0].id);
  expect(requests.map(request => request.authorization)).toEqual([
    'Bearer fixture-token-1+/=',
    'Bearer fixture-token-2+/=',
  ]);
  const bindings = await page.evaluate(() => (window as unknown as FixtureWindow).bindings);
  expect(bindings).toEqual(
    [0, 1].map(() => ({
      submissionId: requests[0].id,
      payloadDigest: createHash('sha256').update(requests[0].body).digest('base64url'),
    }))
  );
  expect(JSON.parse(requests[0].body)).toEqual({
    schemaVersion: 1,
    title: 'Unicode café 🐞',
    description: 'A real packed SDK with an uncertain response.',
    category: 'bug',
  });
  const leaks = await page.evaluate(() => ({
    markup:
      document.documentElement.outerHTML +
      document.querySelector('#bugdrop-managed-host')!.shadowRoot!.innerHTML,
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(leaks.markup).not.toContain('fixture-token-');
  expect(leaks.local).toEqual([]);
  expect(leaks.session).toEqual([]);
});

test('verifier-only success cannot become a delivered confirmation', async ({ page }) => {
  const host = await boot(
    page,
    async route => {
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': appOrigin },
        contentType: 'application/json',
        body: JSON.stringify({ schemaVersion: 1, status: 'verified' }),
      });
    },
    false
  );
  await expect(host.locator('[data-action="open"]')).toBeHidden();
  await page.evaluate(() => (window as unknown as FixtureWindow).controller.open());
  await host.locator('input[name="title"]').fill('Verified is not delivered');
  await host
    .locator('textarea[name="description"]')
    .fill('No Issue has been created by verification.');
  await host.locator('[data-action="submit"]').click();
  await expect(host.locator('[data-action="check-result"]')).toBeVisible();
  await expect(host.locator('[data-role="receipt"]')).toBeEmpty();
  await expect(host.locator('[data-role="status"]')).not.toContainText(/^delivered/i);
});

test('dialog is keyboard reachable and restores focus on close', async ({ page }) => {
  const host = await boot(page, async () => {
    throw new Error('No submission expected');
  });
  await host.locator('[data-action="open"]').focus();
  await page.keyboard.press('Enter');
  await expect(host.locator('[data-role="dialog"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(host.locator('[data-role="dialog"]')).toBeHidden();
  await expect(host.locator('[data-action="open"]')).toBeFocused();
});

test('a rejected expired token can be replaced without losing the report', async ({ page }) => {
  const bodies: string[] = [];
  const host = await boot(page, async route => {
    bodies.push(route.request().postData()!);
    await route.fulfill({
      status: bodies.length === 1 ? 401 : 200,
      headers: { 'Access-Control-Allow-Origin': appOrigin },
      contentType: 'application/json',
      body: JSON.stringify(
        bodies.length === 1
          ? { schemaVersion: 1, error: { code: 'invalid_capability', retryable: false } }
          : { schemaVersion: 1, status: 'delivered', receiptId }
      ),
    });
  });
  await host.locator('[data-action="open"]').click();
  await host.locator('input[name="title"]').fill('Expired in transit');
  await host
    .locator('textarea[name="description"]')
    .fill('Keep my feedback while replacing authorization.');
  await host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await host.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(host.locator('[data-role="status"]')).toContainText('Feedback delivered.');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  const bindings = await page.evaluate(() => (window as unknown as FixtureWindow).bindings);
  expect(bindings).toHaveLength(2);
  expect(bindings[0]).toEqual(bindings[1]);
});

test('definitive rejection lets the reporter correct the retained draft', async ({ page }) => {
  let attempts = 0;
  const host = await boot(page, async route => {
    attempts++;
    await route.fulfill({
      status: attempts === 1 ? 400 : 200,
      headers: { 'Access-Control-Allow-Origin': appOrigin },
      contentType: 'application/json',
      body: JSON.stringify(
        attempts === 1
          ? { schemaVersion: 1, error: { code: 'invalid_request', retryable: false } }
          : { schemaVersion: 1, status: 'delivered', receiptId }
      ),
    });
  });
  await host.locator('[data-action="open"]').click();
  await host.locator('input[name="title"]').fill('Keep my draft');
  await host.locator('textarea[name="description"]').fill('This report was definitively rejected.');
  await host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await host.getByRole('button', { name: 'Edit feedback', exact: true }).click();
  await expect(host.locator('input[name="title"]')).toHaveValue('Keep my draft');
  await host.locator('input[name="title"]').fill('Corrected draft');
  await host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(host.locator('[data-role="status"]')).toContainText('Feedback delivered.');
  const bindings = await page.evaluate(() => (window as unknown as FixtureWindow).bindings);
  expect(bindings).toHaveLength(2);
  expect(bindings[0].submissionId).not.toBe(bindings[1].submissionId);
  expect(bindings[0].payloadDigest).not.toBe(bindings[1].payloadDigest);
});
