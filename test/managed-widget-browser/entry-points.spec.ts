import { createHash } from 'node:crypto';
import { test, expect, type Page, type Route } from '@playwright/test';
import {
  setupEntryPoint,
  corsHeaders,
  entryPoints,
  type FixtureWindow,
} from './entry-point-fixture';

const receiptId = '00000000-0000-4000-8000-000000000001';

for (const entryPoint of entryPoints) {
  test.describe(entryPoint, () => {
    const boot = async (
      page: Page,
      submit: (route: Route) => Promise<void>,
      options?: Parameters<typeof setupEntryPoint>[3]
    ) => (await setupEntryPoint(page, entryPoint, submit, options)).host;

    for (const theme of ['light', 'dark'] as const) {
      test(`applies the managed accent in ${theme} mode and restores focus`, async ({ page }) => {
        test.skip(
          entryPoint === 'packed SDK' && process.env.BUGDROP_MANAGED_PRESENTATION === '0',
          'The previous SDK predates presentation support'
        );
        const host = await boot(
          page,
          async () => {
            throw new Error('No submission expected');
          },
          { accentColor: '#a1236f', theme }
        );
        const launcher = host.getByRole('button', { name: 'Feedback', exact: true });
        await expect(launcher).toHaveCSS('background-color', 'rgb(161, 35, 111)');
        await expect(launcher).toHaveCSS('left', '20px');
        await launcher.click();
        const dialog = host.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveCSS(
          'background-color',
          theme === 'dark' ? 'rgb(23, 32, 42)' : 'rgb(255, 255, 255)'
        );
        await expect(dialog.getByRole('button', { name: 'Send feedback' })).toHaveCSS(
          'background-color',
          'rgb(161, 35, 111)'
        );
        await page.keyboard.press('Escape');
        await expect(launcher).toBeFocused();
      });
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
            headers: corsHeaders,
            contentType: 'application/json',
            body: JSON.stringify({ schemaVersion: 1, status: 'delivered', receiptId }),
          });
        },
        { providerDelayMs: 8000 }
      );
      await host.locator('[data-action="open"]').click();
      await host.locator('input[name="title"]').fill('Slow authorization');
      await host.locator('textarea[name="description"]').fill('Confirm the first delivery.');
      await host.locator('[data-action="submit"]').click();
      await expect(host.locator('[data-role="receipt"]')).toContainText(receiptId, {
        timeout: 20000,
      });
      await expect(host.locator('[data-role="status"]')).toHaveText('Feedback delivered.');
      await expect(host.locator('[data-action="check-result"]')).toBeHidden();
      expect(submissions).toBe(1);
      expect(await page.evaluate(() => (window as unknown as FixtureWindow).bindings.length)).toBe(
        1
      );
    });

    test('lost response retries one frozen submission', async ({ page }) => {
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
            headers: corsHeaders,
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
            headers: corsHeaders,
            contentType: 'application/json',
            body: JSON.stringify({ schemaVersion: 1, status: 'verified' }),
          });
        },
        { button: false }
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
          headers: corsHeaders,
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
          headers: corsHeaders,
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
      await host
        .locator('textarea[name="description"]')
        .fill('This report was definitively rejected.');
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
  });
}
