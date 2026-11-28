import { test, expect, type Page } from '@playwright/test';
import {
  applicationId,
  corsHeaders,
  entryPoints,
  setupEntryPoint,
  submissionUrl,
  type FixtureWindow,
} from './entry-point-fixture';

interface SetupOptions {
  rejectRetry?: boolean;
  failAuthorizationCalls?: number[];
  pendingAuthorization?: boolean;
  response?: 'delivered' | 'internal_error';
}

for (const entryPoint of entryPoints) {
  test.describe(entryPoint, () => {
    async function setup(page: Page, options: SetupOptions = {}) {
      let attempts = 0;
      const fixture = await setupEntryPoint(
        page,
        entryPoint,
        async route => {
          attempts++;
          if (options.rejectRetry && attempts > 1) {
            return route.fulfill({
              status: 403,
              headers: corsHeaders,
              json: { schemaVersion: 1, error: { code: 'forbidden', retryable: false } },
            });
          }
          if (!options.response) return route.abort('failed');
          return route.fulfill({
            status: options.response === 'delivered' ? 200 : 500,
            headers: corsHeaders,
            json:
              options.response === 'delivered'
                ? {
                    schemaVersion: 1,
                    status: 'delivered',
                    receiptId: '00000000-0000-4000-8000-000000000001',
                  }
                : { schemaVersion: 1, error: { code: 'internal_error', retryable: true } },
          });
        },
        {
          failAuthorizationCalls: options.failAuthorizationCalls,
          pendingAuthorization: options.pendingAuthorization,
        }
      );
      const open = () =>
        page.evaluate(() => (window as unknown as FixtureWindow).controller.open());
      await open();
      return {
        host: fixture.host,
        attempts: () => attempts,
        async boot() {
          await fixture.boot();
          await open();
        },
      };
    }

    test('lost response followed by cold reload blocks a replacement report', async ({ page }) => {
      const fixture = await setup(page);
      await fixture.host.locator('input[name="title"]').fill('Potential duplicate');
      await fixture.host
        .locator('textarea[name="description"]')
        .fill('Private report text must not persist');
      await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
      await expect(
        fixture.host.getByRole('button', { name: 'Check result', exact: true })
      ).toBeVisible();
      expect(fixture.attempts()).toBe(1);
      await page.reload();
      await fixture.boot();
      await expect(fixture.host.locator('[data-role="status"]')).toContainText(
        'Contact the site owner'
      );
      await expect(fixture.host.locator('form')).toBeHidden();
      await expect(fixture.host.locator('[data-action="check-result"]')).toBeHidden();
      await expect(fixture.host.locator('[data-action="new-report"]')).toBeHidden();
      await fixture.host
        .locator('form')
        .evaluate(form =>
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        );
      expect(fixture.attempts()).toBe(1);
      const stored = await page.evaluate(() =>
        JSON.stringify({
          local: Object.entries(localStorage),
          session: Object.entries(sessionStorage),
        })
      );
      expect(stored).not.toContain('Private report');
      expect(stored).not.toContain('fixture-token-');
    });

    for (const failure of ['unavailable', 'corrupt', 'no-locks']) {
      test(`blocks submission when recovery state is ${failure}`, async ({ page }) => {
        await page.addInitScript(
          ({ failure, recoveryKey }) => {
            if (failure === 'unavailable')
              Object.defineProperty(window, 'localStorage', {
                get() {
                  throw new Error('Storage denied');
                },
              });
            else if (failure === 'no-locks')
              Object.defineProperty(navigator, 'locks', { value: undefined });
            else localStorage.setItem(recoveryKey, 'corrupt');
          },
          {
            failure,
            recoveryKey: `bugdrop:unresolved:v1:${JSON.stringify([applicationId, submissionUrl])}`,
          }
        );
        const fixture = await setup(page);
        await expect(fixture.host.locator('[data-role="status"]')).toContainText(
          'Contact the site owner'
        );
        await expect(fixture.host.locator('form')).toBeHidden();
        expect(fixture.attempts()).toBe(0);
        expect(
          await page.evaluate(() => (window as unknown as FixtureWindow).bindings.length)
        ).toBe(0);
      });
    }

    test('two tabs cannot start competing reports in one Application', async ({
      page,
      context,
    }) => {
      const otherPage = await context.newPage();
      const first = await setup(page);
      const second = await setup(otherPage);
      for (const fixture of [first, second]) {
        await fixture.host.locator('input[name="title"]').fill('Same report');
        await fixture.host.locator('textarea[name="description"]').fill('Concurrent submit');
      }
      await Promise.all(
        [first, second].map(fixture =>
          fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click()
        )
      );
      await expect
        .poll(async () => {
          const values = await Promise.all(
            [first, second].map(fixture =>
              fixture.host.locator('[data-role="status"]').textContent()
            )
          );
          return values.filter(value => value?.includes('Contact the site owner')).length;
        })
        .toBe(1);
      await expect.poll(() => first.attempts() + second.attempts()).toBe(1);
    });

    test('a denial after uncertainty cannot unlock a cold reload', async ({ page }) => {
      const fixture = await setup(page, { rejectRetry: true });
      await fixture.host.locator('input[name="title"]').fill('Unresolved report');
      await fixture.host.locator('textarea[name="description"]').fill('Revoked during recovery');
      await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
      await fixture.host.getByRole('button', { name: 'Check result', exact: true }).click();
      await expect.poll(() => fixture.attempts()).toBe(2);
      await expect(
        fixture.host.getByRole('button', { name: 'Check result', exact: true })
      ).toBeVisible();
      await page.reload();
      await fixture.boot();
      await expect(fixture.host.locator('[data-role="status"]')).toContainText(
        'Contact the site owner'
      );
      await expect(fixture.host.locator('form')).toBeHidden();
      expect(fixture.attempts()).toBe(2);
    });

    test('a failed durable write prevents authorization and delivery', async ({ page }) => {
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new Error('Quota exceeded');
        };
      });
      const fixture = await setup(page);
      await fixture.host.locator('input[name="title"]').fill('Must not send');
      await fixture.host.locator('textarea[name="description"]').fill('Storage is full');
      await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
      await expect(fixture.host.locator('[data-role="status"]')).toContainText(
        'Contact the site owner'
      );
      expect(fixture.attempts()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as FixtureWindow).bindings.length)).toBe(
        0
      );
    });

    test('authorization-only failure permits a fresh draft after reload without submitting', async ({
      page,
    }) => {
      const fixture = await setup(page, { failAuthorizationCalls: [1] });
      await fixture.host.locator('input[name="title"]').fill('Not dispatched');
      await fixture.host
        .locator('textarea[name="description"]')
        .fill('Authorization is unavailable');
      await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
      await expect(fixture.host.locator('[data-role="status"]')).toContainText(
        'Unable to authorize'
      );
      expect(fixture.attempts()).toBe(0);
      await page.reload();
      await fixture.boot();
      await expect(fixture.host.locator('form')).toBeVisible();
      expect(fixture.attempts()).toBe(0);
    });

    test('manual retry after authorization failure preserves the prepared report', async ({
      page,
    }) => {
      const fixture = await setup(page, { failAuthorizationCalls: [1], response: 'delivered' });
      await fixture.host.locator('input[name="title"]').fill('Retry authorization');
      await fixture.host.locator('textarea[name="description"]').fill('Same frozen report');
      await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
      await fixture.host.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(fixture.host.locator('[data-role="status"]')).toHaveText('Feedback delivered.');
      expect(fixture.attempts()).toBe(1);
      const bindings = await page.evaluate(() => (window as unknown as FixtureWindow).bindings);
      expect(bindings).toHaveLength(2);
      expect(bindings[1]).toEqual(bindings[0]);
      await page.reload();
      await fixture.boot();
      await expect(fixture.host.locator('form')).toBeVisible();
    });

    for (const response of [undefined, 'internal_error'] as const) {
      test(`${response ?? 'lost response'} then authorization failure retains the reload lock`, async ({
        page,
      }) => {
        const fixture = await setup(page, { failAuthorizationCalls: [2], response });
        await fixture.host.locator('input[name="title"]').fill('Previously dispatched');
        await fixture.host
          .locator('textarea[name="description"]')
          .fill('Do not replace this report');
        await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
        await fixture.host.locator('[data-action="check-result"]').click();
        await expect
          .poll(() => page.evaluate(() => (window as unknown as FixtureWindow).bindings.length))
          .toBe(2);
        await expect(fixture.host.locator('[data-role="status"]')).toContainText(
          response ? 'Unable to authorize' : 'could not be confirmed'
        );
        expect(fixture.attempts()).toBe(1);
        await page.reload();
        await fixture.boot();
        await expect(fixture.host.locator('[data-role="status"]')).toContainText(
          'Contact the site owner'
        );
        await expect(fixture.host.locator('form')).toBeHidden();
        expect(fixture.attempts()).toBe(1);
      });
    }

    test('reload during pending authorization retains the unresolved lock', async ({ page }) => {
      const fixture = await setup(page, { pendingAuthorization: true });
      await fixture.host.locator('input[name="title"]').fill('Still authorizing');
      await fixture.host.locator('textarea[name="description"]').fill('No settled result yet');
      await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => (window as unknown as FixtureWindow).bindings.length))
        .toBe(1);
      await page.reload();
      await fixture.boot();
      await expect(fixture.host.locator('[data-role="status"]')).toContainText(
        'Contact the site owner'
      );
      await expect(fixture.host.locator('form')).toBeHidden();
      expect(fixture.attempts()).toBe(0);
    });

    test('a retry cannot bypass another tab that acquired the released marker', async ({
      page,
      context,
    }) => {
      const first = await setup(page, { failAuthorizationCalls: [1] });
      await first.host.locator('input[name="title"]').fill('First draft');
      await first.host.locator('textarea[name="description"]').fill('Failed authorization');
      await first.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
      await expect(first.host.locator('[data-role="status"]')).toContainText('Unable to authorize');
      const otherPage = await context.newPage();
      const second = await setup(otherPage);
      await second.host.locator('input[name="title"]').fill('Other tab');
      await second.host.locator('textarea[name="description"]').fill('Now owns the marker');
      await second.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
      await expect(second.host.locator('[data-action="check-result"]')).toBeVisible();
      await first.host.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(first.host.locator('[data-role="status"]')).toContainText(
        'Contact the site owner'
      );
      expect(first.attempts()).toBe(0);
      expect(second.attempts()).toBe(1);
      expect(await page.evaluate(() => (window as unknown as FixtureWindow).bindings.length)).toBe(
        1
      );
    });
  });
}
